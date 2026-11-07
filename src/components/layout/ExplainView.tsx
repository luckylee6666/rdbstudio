import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { AlertTriangle, Flame, Loader2, RefreshCw } from "lucide-react";
import { QueryParametersDialog } from "@/components/editor/QueryParametersDialog";
import { mergeParameterDefaults, type QueryParameter } from "@/lib/queryParameters";
import { useWorkspace } from "@/store/workspace";
import type { WorkspaceTab } from "@/types";
import { api } from "@/lib/api";
import {
  flattenPlan,
  parseMysqlPlan,
  parsePgPlan,
  parseSqliteQueryPlan,
  selfCost,
  stripLeadingExplain,
  type PlanNode,
} from "@/lib/explain";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { explainWrap, isReadOnlyStatement } from "@/lib/sql";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { cn } from "@/lib/cn";
import { useTheme } from "@/components/theme/ThemeProvider";
import { FitVisibleGraph } from "@/components/er/FitVisibleGraph";

type LoadState =
  | { kind: "loading" }
  | { kind: "parameters" }
  | { kind: "ready" }
  | { kind: "error"; message: string; hint?: boolean }
  | { kind: "ok"; roots: PlanNode[] };

const NODE_W = 260;

function nodeHeight(n: PlanNode): number {
  // padding (py-2 = 16) + label line + optional detail/meta lines + border.
  const lines =
    17 +
    (n.detail ? 15 : 0) +
    (n.cost || n.rows != null ? 14 : 0) +
    (n.actual ? 14 : 0);
  return 16 + lines + 2;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function ExplainView({ tab }: { tab: WorkspaceTab }) {
  const { theme } = useTheme();
  const connectionId = tab.connectionId;
  const sql = tab.sql ?? "";
  const connections = useConnections((s) => s.list);
  const cfg = useMemo(
    () => connections.find((c) => c.id === connectionId),
    [connections, connectionId]
  );
  const driver = cfg?.driver;
  const analyze = tab.id.startsWith("explain-analyze:");
  const sourceQueryId = tab.sourceQueryId;
  const sourceSessionIdentity = tab.sourceSessionIdentity;
  const active = useWorkspace(workspace => workspace.activeTabId === tab.id);
  const graphContainer = useRef<HTMLDivElement>(null);
  const sourceName = useWorkspace(workspace => workspace.tabs.find(item => item.id === sourceQueryId)?.title);
  const matchesSnapshot = (snapshot: WorkspaceTab["explainSnapshot"]) => snapshot?.connectionId === connectionId && snapshot?.sql === sql && snapshot?.analyze === analyze && snapshot?.sourceSessionIdentity === sourceSessionIdentity;
  const [state, setState] = useState<LoadState>(() => matchesSnapshot(tab.explainSnapshot) ? { kind: "ok", roots: tab.explainSnapshot!.roots } : { kind: "loading" });
  const [confirmAnalyze, setConfirmAnalyze] = useState(false);
  const t = useT();
  const request = useRef<string | null>(null);
  const [pending, setPending] = useState<{ names: string[]; generation: number } | null>(null);
  const values = useRef<QueryParameter[]>([]);
  // Analyze plans are opened with an `explain-analyze:` tab id; only
  // PostgreSQL re-runs the statement for real, other drivers ignore the flag.

  const load = useCallback(async (parameters?: QueryParameter[], generation?: number) => {
    if (request.current) return;
    if (!connectionId || !sql.trim()) {
      setState({ kind: "error", message: t("explain.no_sql") });
      return;
    }
    if (!cfg) {
      setState({ kind: "error", message: t("explain.err.no_connection") });
      return;
    }
    if (driver !== "postgres" && driver !== "sqlite" && driver !== "mysql") {
      setState({ kind: "error", message: t("explain.unsupported") });
      return;
    }
    const qid = crypto.randomUUID();
    request.current = qid;
    const owns = () => request.current === qid;
    setState({ kind: "loading" });
    useWorkspace.setState(workspace => ({ tabs: workspace.tabs.map(item => item.id === tab.id ? { ...item, explainRunning: true, explainSnapshot: undefined } : item) }));
    try {
      if (!sourceQueryId || !sourceSessionIdentity) throw new Error(t("explain.source_closed"));
      {
        if (!useWorkspace.getState().tabs.some(item => item.id === sourceQueryId && item.kind === "query")) throw new Error(t("explain.source_closed"));
        await api.attachEditorPlan(connectionId, sourceQueryId, tab.id, sourceSessionIdentity);
        if (!owns()) {
          if (!useWorkspace.getState().tabs.some(item => item.id === tab.id)) void api.closeEditorSession(tab.id).catch(() => {});
          return;
        }
      }
      const body = stripLeadingExplain(sql).replace(/;\s*$/, "");
      const wrapped = explainWrap(body, driver, { analyze, format: "json" });
      if (!parameters && /:[A-Za-z_]/.test(body)) {
        const analysis = await api.queryParameterNames(connectionId, [wrapped], tab.id, qid);
        if (!owns()) return;
        if (analysis.names.length) {
          setPending(analysis);
          setState({ kind: "parameters" });
          return;
        }
      }
      let res;
      if (parameters) {
        const outcome = await api.executeParameterQuery(connectionId, { sqls: [wrapped], parameters, generation, sessionId: tab.id, queryId: qid, atomic: false });
        if (!owns()) return;
        if (outcome.status === "failed") throw new Error(outcome.error);
        res = outcome.result;
      } else {
        res = await api.executeQuery(connectionId, wrapped, qid, tab.id);
      }
      if (!owns()) return;
      let roots: PlanNode[];
      if (driver === "sqlite") roots = parseSqliteQueryPlan(res.rows);
      else {
        const cell = res.rows[0]?.[0];
        if (cell == null) throw new Error(t("explain.empty"));
        roots = [driver === "postgres" ? parsePgPlan(cell) : parseMysqlPlan(cell)];
      }
      setState({ kind: "ok", roots });
      useWorkspace.setState(workspace => ({ tabs: workspace.tabs.map(item => item.id === tab.id ? { ...item, explainSnapshot: { sourceSessionIdentity, connectionId, sql, analyze, roots } } : item) }));
    } catch (e) {
      if (owns()) setState({ kind: "error", message: String(e), hint: true });
    } finally {
      if (owns()) {
        request.current = null;
        useWorkspace.setState(workspace => ({ tabs: workspace.tabs.map(item => item.id === tab.id ? { ...item, explainRunning: false } : item) }));
      }
      if (sourceQueryId) void api.editorSessionStatus(sourceQueryId).then(status => {
        if (status) window.dispatchEvent(new CustomEvent("editor-session-updated", { detail: { sessionId: sourceQueryId, status } }));
      }).catch(() => {});
    }
    // t changes identity every render; inputs below identify the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, sql, driver, cfg, analyze, tab.id, sourceQueryId, sourceSessionIdentity]);

  useEffect(() => {
    let active = true;
    setPending(null);
    // Defer the initial request so StrictMode's setup/cleanup rehearsal cannot
    // execute ANALYZE twice. Consume explicit intent once, before any IPC.
    queueMicrotask(() => {
      if (!active) return;
      const current = useWorkspace.getState().tabs.find(item => item.id === tab.id) ?? tab;
      if (matchesSnapshot(current.explainSnapshot)) {
        setState({ kind: "ok", roots: current.explainSnapshot!.roots });
        return;
      }
      if (analyze && !current.explainRequested) {
        setState({ kind: "ready" });
        return;
      }
      if (cfg) useWorkspace.setState(workspace => ({ tabs: workspace.tabs.map(item => item.id === tab.id ? { ...item, explainRequested: false } : item) }));
      void load();
    });
    return () => {
      active = false;
      const qid = request.current;
      request.current = null;
      if (qid) void api.cancelQuery(qid).catch(() => {});
      useWorkspace.setState(workspace => ({ tabs: workspace.tabs.map(item => item.id === tab.id ? { ...item, explainRunning: false } : item) }));
    };
    // Runtime snapshots and consumed request flags must not retrigger loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const refresh = () => {
    if (analyze && !isReadOnlyStatement(sql)) setConfirmAnalyze(true);
    else void load();
  };

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
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setLocalNodes((nds) => applyNodeChanges(changes, nds));
  }, []);

  const rootCost =
    state.kind === "ok" && (driver === "postgres" || driver === "mysql")
      ? state.roots[0]?.cost?.total
      : undefined;
  const rootActualTime =
    state.kind === "ok" && analyze ? state.roots[0]?.actual?.time : undefined;
  const nodeCount = state.kind === "ok" ? flattenPlan(state.roots).length : 0;

  return (
    <div className="flex h-full flex-col">
      <ConfirmDialog open={confirmAnalyze && active} title={t("explain.analyze.warning_title")} message={t("explain.analyze.warning")}
        confirmLabel={t("explain.analyze.proceed")} cancelLabel={t("common.cancel")} danger onConfirm={() => void load()} onClose={() => setConfirmAnalyze(false)} />
      {pending && active && <QueryParametersDialog names={pending.names} previous={values.current} defaults={tab.queryParameterDefaults ?? []} connectionName={cfg?.name ?? ""}
        driver={cfg?.driver}
        onClose={() => { setPending(null); setState({ kind: "error", message: t("query.err.cancelled") }); }}
        onRun={(parameters, inputs) => {
          const generation = pending.generation;
          values.current = parameters;
          useWorkspace.setState(workspace => ({ tabs: workspace.tabs.map(item => item.id === tab.id ? { ...item, queryParameterDefaults: mergeParameterDefaults(item.queryParameterDefaults ?? [], inputs) } : item) }));
          setPending(null);
          void load(parameters, generation);
        }}
      />}
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-3 py-1 border-b border-border/70 bg-surface/30 px-3 text-[11.5px] text-muted-foreground">
        <span className="text-foreground/90">{cfg?.name ?? tab.subtitle}</span>
        {cfg?.read_only ? <span>{t("explain.readonly_session")}</span> : sourceQueryId && <span className="max-w-48 truncate" title={sourceName ?? t("explain.source_closed")}>{t("explain.source", { name: sourceName ?? "—" })}</span>}
        {driver && (
          <span className="rounded bg-surface-muted/70 px-1.5 py-0.5 text-[9.5px] uppercase tracking-wider">
            {driver}
          </span>
        )}
        {analyze && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9.5px] font-medium uppercase tracking-wider text-warning">
            {t("explain.analyze.badge")}
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
        {rootActualTime != null && (
          <>
            <span>·</span>
            <span>
              {t("explain.actual")}{" "}
              <span className="font-mono text-foreground/80">
                {fmt(rootActualTime)} ms
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
          onClick={refresh}
          disabled={state.kind === "loading" || !!pending}
          className="flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          <RefreshCw className="h-3 w-3" />
          {t(analyze ? "explain.analyze.run_again" : "explain.refresh")}
        </button>
      </div>
      <div ref={graphContainer} className="min-h-0 flex-1">
        {state.kind === "ready" ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
            <p>{t("explain.analyze.ready")}</p>
            <button className="rounded-md bg-brand px-3 py-2 text-brand-foreground" onClick={refresh}>{t("explain.analyze.run_again")}</button>
          </div>
        ) : state.kind === "error" ? (
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
        ) : state.kind === "loading" || state.kind === "parameters" ? (
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
            deleteKeyCode={null}
            colorMode={theme}
            proOptions={{ hideAttribution: true }}
            minZoom={0.25}
            maxZoom={1.75}
          >
            <FitVisibleGraph active={active} container={graphContainer} revision={graph.nodes} />
            <Background
              variant={BackgroundVariant.Dots}
              color="hsl(var(--border))"
              gap={18}
              size={1.2}
            />
            <Controls
              showInteractive={false}
              className="overflow-hidden rounded-lg border border-border !shadow-soft"
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
  const t = useT();
  const { plan, hot } = data;
  const estimate: string[] = [];
  if (plan.cost) {
    estimate.push(`cost ${fmt(plan.cost.startup)}..${fmt(plan.cost.total)}`);
  }
  if (plan.rows != null) estimate.push(`rows ${fmt(plan.rows)}`);
  const meta = estimate.length ? [estimate.join(" · ")] : [];
  if (plan.actual) {
    const actual: string[] = [];
    if (plan.actual.time != null) actual.push(`${fmt(plan.actual.time)} ms`);
    if (plan.actual.rows != null) actual.push(`${fmt(plan.actual.rows)} rows`);
    if (plan.actual.loops != null && plan.actual.loops > 1) {
      actual.push(`${fmt(plan.actual.loops)} ${t("explain.loops")}`);
    }
    if (actual.length > 0) {
      meta.push(`${t("explain.actual")} ${actual.join(" · ")}`);
    }
  }
  const title = [plan.label, plan.detail, ...meta]
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
        <div className="truncate font-mono text-[10.5px] leading-[15px] text-sky-600 dark:text-sky-300">
          {plan.detail}
        </div>
      )}
      {meta.map((line, index) => (
        <div key={index} className="truncate font-mono text-[10px] leading-[14px] text-muted-foreground">
          {line}
        </div>
      ))}
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
  // SQLite plans are a list of top-level steps in loop order; chain them
  // for layout only so they stack top-to-bottom instead of spreading into a
  // row that fitView then shrinks into unreadable text.
  for (let i = 1; i < roots.length; i++) g.setEdge(roots[i - 1].id, roots[i].id);
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
