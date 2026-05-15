import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import type { TableDescription } from "@/types";
import { KeyRound, Link2 } from "lucide-react";
import { cn } from "@/lib/cn";

type TableNodeData = {
  desc: TableDescription;
};

const NODE_WIDTH = 240;
const HEADER_H = 32;
const ROW_H = 22;
const FOOTER_H = 12;

function nodeHeight(t: TableDescription) {
  return HEADER_H + t.columns.length * ROW_H + FOOTER_H;
}

export function ERDiagram({ tables }: { tables: TableDescription[] }) {
  const [hoverTable, setHoverTable] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => buildGraph(tables), [tables]);
  const [localNodes, setLocalNodes] = useState<Node[]>(nodes);

  useEffect(() => {
    setLocalNodes(nodes);
  }, [nodes]);

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

  const decoratedEdges: Edge[] = edges.map((e) => ({
    ...e,
    animated: hoverTable === e.source || hoverTable === e.target,
    style: {
      ...e.style,
      stroke:
        hoverTable === e.source || hoverTable === e.target
          ? "hsl(var(--brand))"
          : "hsl(var(--muted-foreground) / 0.5)",
      strokeWidth:
        hoverTable === e.source || hoverTable === e.target ? 2 : 1,
    },
  }));

  const decoratedNodes: Node[] = localNodes.map((n) => ({
    ...n,
    data: {
      ...(n.data as TableNodeData),
      onHover: setHoverTable,
      highlighted:
        hoverTable === n.id ||
        edges.some(
          (e) =>
            (e.source === hoverTable && e.target === n.id) ||
            (e.target === hoverTable && e.source === n.id)
        ),
    },
  }));

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={decoratedNodes}
        edges={decoratedEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        fitView
        fitViewOptions={{ padding: 0.2 }}
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
        <MiniMap
          pannable
          zoomable
          nodeColor={() => "hsl(var(--brand))"}
          maskColor="hsl(var(--background) / 0.8)"
          style={{
            background: "hsl(var(--surface-elevated))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
          }}
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
    </div>
  );
}

const nodeTypes = {
  table: TableNode,
};

type TableNodeProps = NodeProps<
  Node<
    TableNodeData & {
      onHover: (id: string | null) => void;
      highlighted: boolean;
    }
  >
>;

function TableNode({ id, data }: TableNodeProps) {
  const { desc, onHover, highlighted } = data;
  return (
    <div
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "overflow-hidden rounded-lg border bg-surface-elevated text-[11.5px] shadow-soft transition-shadow",
        highlighted
          ? "border-brand shadow-[0_0_0_1px_hsl(var(--brand)/0.4),_0_10px_30px_-12px_hsl(var(--brand)/0.4)]"
          : "border-border/80"
      )}
      style={{ width: NODE_WIDTH }}
    >
      <div
        className={cn(
          "flex h-8 items-center justify-between px-3 border-b border-border/80",
          highlighted ? "bg-brand/15" : "bg-surface-muted/70"
        )}
      >
        <span className="truncate font-semibold">{desc.name}</span>
        {desc.schema && (
          <span className="rounded bg-surface px-1.5 text-[9px] uppercase tracking-wider text-muted-foreground">
            {desc.schema}
          </span>
        )}
      </div>
      <ul className="divide-y divide-border/50">
        {desc.columns.map((c) => (
          <li
            key={c.name}
            className="flex h-[22px] items-center gap-1.5 px-3"
          >
            {c.is_primary_key ? (
              <KeyRound className="h-2.5 w-2.5 shrink-0 text-brand" />
            ) : desc.foreign_keys.some((f) => f.columns.includes(c.name)) ? (
              <Link2 className="h-2.5 w-2.5 shrink-0 text-emerald-400" />
            ) : (
              <span className="h-2.5 w-2.5" />
            )}
            <span
              className={cn(
                "flex-1 truncate font-mono",
                c.is_primary_key && "font-semibold"
              )}
            >
              {c.name}
            </span>
            <span className="truncate font-mono text-[10px] text-sky-300">
              {c.data_type}
            </span>
            {!c.nullable && (
              <span className="text-[9px] text-muted-foreground">!</span>
            )}
          </li>
        ))}
      </ul>
      <div className="h-3 bg-surface-muted/40" />
    </div>
  );
}

function buildGraph(tables: TableDescription[]): {
  nodes: Node[];
  edges: Edge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "LR", nodesep: 60, ranksep: 100 });

  for (const t of tables) {
    g.setNode(t.name, { width: NODE_WIDTH, height: nodeHeight(t) });
  }
  const edges: Edge[] = [];
  for (const t of tables) {
    for (const fk of t.foreign_keys) {
      if (tables.find((x) => x.name === fk.referenced_table)) {
        g.setEdge(t.name, fk.referenced_table);
        edges.push({
          id: `fk:${t.name}:${fk.name}`,
          source: t.name,
          target: fk.referenced_table,
          type: "smoothstep",
          label: fk.columns.join(","),
          labelStyle: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
        });
      }
    }
  }
  dagre.layout(g);

  const nodes: Node[] = tables.map((t) => {
    const n = g.node(t.name);
    return {
      id: t.name,
      type: "table",
      data: { desc: t },
      position: {
        x: (n?.x ?? 0) - NODE_WIDTH / 2,
        y: (n?.y ?? 0) - nodeHeight(t) / 2,
      },
    };
  });

  return { nodes, edges };
}
