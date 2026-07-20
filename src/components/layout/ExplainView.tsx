import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { AlertTriangle, Flame, Loader2, RefreshCw } from "lucide-react";
import type { WorkspaceTab } from "@/types";
import { api } from "@/lib/api";
import {
  flattenPlan,
  parsePgPlan,
  parseSqliteQueryPlan,
  selfCost,
  stripLeadingExplain,
  type PlanNode,
} from "@/lib/explain";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { cn } from "@/lib/cn";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string; hint?: boolean }
  | { kind: "ok"; roots: PlanNode[] };

const NODE_W = 260;

function nodeHeight(n: PlanNode): number {
  // padding (py-2 = 16) + label line + optional detail/meta lines + border.
  const lines =
    17 + (n.detail ? 15 : 0) + (n.cost || n.rows != null ? 14 : 0);
  return 16 + lines + 2;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function ExplainView({ tab }: { tab: WorkspaceTab }) {
  const connectionId = tab.connectionId;
  const sql = tab.sql ?? "";
  const connections = useConnections((s) => s.list);
  const cfg = useMemo(
    () => connections.find((c) => c.id === connectionId),
    [connections, connectionId]
  );
  const driver = cfg?.driver;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const t = useT();

  const load = useCallback(async () => {
    if (!connectionId || !sql.trim()) {
      setState({ kind: "error", message: t("explain.no_sql") });
      return;
    }
    if (!cfg) {
      setState({ kind: "error", message: t("explain.err.no_connection") });
      return;
    }
    if (driver !== "postgres" && driver !== "sqlite") {
      setState({ kind: "error", message: t("explain.unsupported") });
      return;
    }
    setState({ kind: "loading" });
    try {
      // Re-wrap in the driver's EXPLAIN form; strip any EXPLAIN the user
      // already typed (and a trailing `;`) to avoid double-wrapping.
      const body = stripLeadingExplain(sql).replace(/;\s*$/, "");
      if (driver === "postgres") {
        const res = await api.executeQuery(
          connectionId,
          `EXPLAIN (FORMAT JSON, VERBOSE true) ${body}`
        );
        const cell = res.rows[0]?.[0];
        if (cell == null) throw new Error(t("explain.empty"));
        setState({ kind: "ok", roots: [parsePgPlan(cell)] });
      } else {
        const res = await api.executeQuery(
          connectionId,
          `EXPLAIN QUERY PLAN ${body}`
        );
        setState({ kind: "ok", roots: parseSqliteQueryPlan(res.rows) });
      }
    } catch (e) {
      setState({ kind: "error", message: String(e), hint: true });
    }
    // t changes identity every render; the effect below keys on real inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, sql, driver, cfg]);

  useEffect(() => {
    void load();
  }, [load]);

  // Hotspot detection (PG only): highlight the node(s) whose SELF cost —
  // Total Cost minus the children's totals — is the maximum of the plan.
  // Total Cost alone is cumulative and would always pick the root.
  const hotIds = useMemo(() => {
    const hot = new Set<string>();
    if (state.kind !== "ok" || driver !== "postgres") return hot;
    const all = flattenPlan(state.roots);
    if (all.length < 2) return hot; // a single node has no hotspot contrast
    let max = 0;
    const costs = new Map<string, number>();
    for (const n of all) {
      const c = selfCost(n);
      costs.set(n.id, c);
      if (c > max) max = c;
    }
    if (max <= 0) return hot;
    // ≥ 99.9% of the max keeps float-equal ties highlighted together.
    for (const [id, c] of costs) if (c >= max * 0.999) hot.add(id);
    return hot;
  }, [state, driver]);

  const graph = useMemo(() => {
    if (state.kind !== "ok") return { nodes: [] as Node[], edges: [] as Edge[] };
    return buildGraph(state.roots, hotIds);
  }, [state, hotIds]);

  // Same lightweight drag support as ERDiagram: local positions, re-seeded
  // whenever the plan reloads.
  const [localNodes, setLocalNodes] = useState<Node[]>(graph.nodes);
  useEffect(() => {
    setLocalNodes(graph.nodes);
  }, [graph.nodes]);
  const onNodesChange = useCallback((changes: any) => {
    setLocalNodes((nds) =>
      nds.map((n) => {
        const ch = changes.find((c: any) => c.id === n.id);
        if (ch?.type === "position" && ch.position) {
          return { ...n, position: ch.position };
        }
        return n;
      })
    );
  }, []);

  const rootCost =
    state.kind === "ok" && driver === "postgres"
      ? state.roots[0]?.cost?.total
      : undefined;
  const nodeCount = state.kind === "ok" ? flattenPlan(state.roots).length : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border/70 bg-surface/30 px-3 text-[11.5px] text-muted-foreground">
        <span className="text-foreground/90">{cfg?.name ?? tab.subtitle}</span>
        {driver && (
          <span className="rounded bg-surface-muted/70 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider">
            {driver}
          </span>
        )}
        {state.kind === "loading" && (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
        {rootCost != null && (
          <>
            <span>·</span>
            <span>
              {t("explain.total_cost")}{" "}
              <span className="font-mono text-foreground/80">
                {fmt(rootCost)}
              </span>
            </span>
          </>
        )}
        {state.kind === "ok" && (
          <>
            <span>·</span>
            <span>{t("explain.nodes", { n: nodeCount })}</span>
          </>
        )}
        {hotIds.size > 0 && (
          <span className="flex items-center gap-1 text-warning">
            <Flame className="h-3 w-3" />
            {t("explain.hotspot")}
          </span>
        )}
        <span
          className="hidden max-w-[320px] truncate font-mono text-[10.5px] md:inline"
          title={sql}
        >
          {sql}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => void load()}
          disabled={state.kind === "loading"}
          className="flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" />
          {t("explain.refresh")}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {state.kind === "error" ? (
          <div className="flex h-full items-start justify-center p-6">
            <div className="max-w-lg rounded-lg border border-danger/40 bg-danger/10 p-4 text-[12.5px]">
              <div className="mb-1 flex items-center gap-2 font-medium text-danger">
                <AlertTriangle className="h-4 w-4" />
                {t("explain.err")}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-foreground/90">
                {state.message}
              </pre>
              {state.hint && (
                <div className="mt-2 text-[11.5px] text-muted-foreground">
                  {t("explain.retry_hint")}
                </div>
              )}
            </div>
          </div>
        ) : state.kind === "loading" ? (
          <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("explain.loading")}
          </div>
        ) : graph.nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">
            {t("explain.empty")}
          </div>
        ) : (
          <ReactFlow
            nodes={localNodes}
            edges={graph.edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            nodesConnectable={false}
            fitView
            fitViewOptions={{ padding: 0.25 }}
            proOptions={{ hideAttribution: true }}
            minZoom={0.25}
            maxZoom={1.75}
          >
            <Background
              variant={BackgroundVariant.Dots}
              color="hsl(var(--border))"
              gap={18}
              size={1.2}
            />
            <Controls
              showInteractive={false}
              style={{
                background: "hsl(var(--surface-elevated))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
              }}
            />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

type PlanNodeData = {
  plan: PlanNode;
  hot: boolean;
};

const nodeTypes = {
  plan: PlanNodeCard,
};

function PlanNodeCard({ data }: NodeProps<Node<PlanNodeData>>) {
  const { plan, hot } = data;
  const title = [
    plan.label,
    plan.detail,
    plan.cost ? `cost=${fmt(plan.cost.startup)}..${fmt(plan.cost.total)}` : null,
    plan.rows != null ? `rows=${fmt(plan.rows)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      title={title}
      className={cn(
        "rounded-lg border bg-surface-elevated px-3 py-2 text-[11.5px] shadow-soft transition-shadow",
        hot
          ? "border-warning shadow-[0_0_0_1px_hsl(var(--warning)/0.35),_0_8px_24px_-10px_hsl(var(--warning)/0.5)]"
          : "border-border/80"
      )}
      style={{ width: NODE_W }}
    >
      <Handle
        type="target"
        position={Position.Top}
        style={{ opacity: 0, width: 4, height: 4, pointerEvents: "none" }}
      />
      <div className="flex items-center gap-1.5 leading-[17px]">
        {hot && <Flame className="h-3 w-3 shrink-0 text-warning" />}
        <span className="truncate font-semibold text-foreground">
          {plan.label}
        </span>
      </div>
      {plan.detail && (
        <div className="truncate font-mono text-[10.5px] leading-[15px] text-sky-300">
          {plan.detail}
        </div>
      )}
      {(plan.cost || plan.rows != null) && (
        <div className="truncate font-mono text-[10px] leading-[14px] text-muted-foreground">
          {plan.cost && `cost ${fmt(plan.cost.startup)}..${fmt(plan.cost.total)}`}
          {plan.cost && plan.rows != null && " · "}
          {plan.rows != null && `rows ${fmt(plan.rows)}`}
        </div>
      )}
      <Handle
        type="source"
        position={Position.Bottom}
        style={{ opacity: 0, width: 4, height: 4, pointerEvents: "none" }}
      />
    </div>
  );
}

function buildGraph(
  roots: PlanNode[],
  hotIds: Set<string>
): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 40, ranksep: 56 });

  const flat = flattenPlan(roots);
  for (const n of flat) {
    g.setNode(n.id, { width: NODE_W, height: nodeHeight(n) });
  }
  const edges: Edge[] = [];
  const walkEdges = (parent: PlanNode) => {
    for (const child of parent.children) {
      g.setEdge(parent.id, child.id);
      edges.push({
        id: `e:${parent.id}:${child.id}`,
        source: parent.id,
        target: child.id,
        type: "smoothstep",
        style: {
          stroke: "hsl(var(--muted-foreground) / 0.5)",
          strokeWidth: 1.25,
        },
      });
      walkEdges(child);
    }
  };
  roots.forEach(walkEdges);
  dagre.layout(g);

  const nodes: Node[] = flat.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      type: "plan",
      data: { plan: n, hot: hotIds.has(n.id) },
      position: {
        x: (pos?.x ?? 0) - NODE_W / 2,
        y: (pos?.y ?? 0) - nodeHeight(n) / 2,
      },
    };
  });

  return { nodes, edges };
}
