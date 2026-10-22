import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
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
import { useTheme } from "@/components/theme/ThemeProvider";

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

export type ErPositions = Record<string, { x: number; y: number }>;

export function loadErPositions(layoutKey?: string): ErPositions {
  if (!layoutKey) return {};
  try {
    const raw = localStorage.getItem(`rdb:erLayout:${layoutKey}`);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveErPositions(layoutKey: string | undefined, pos: ErPositions) {
  if (!layoutKey) return;
  try {
    if (Object.keys(pos).length === 0) {
      localStorage.removeItem(`rdb:erLayout:${layoutKey}`);
    } else {
      localStorage.setItem(`rdb:erLayout:${layoutKey}`, JSON.stringify(pos));
    }
  } catch {
    /* ignore storage errors */
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Synthesize a standalone, crisp vector SVG of the ER diagram using either
 * user-arranged node positions or the default Dagre layout.
 */
export function buildErSvg(
  tables: TableDescription[],
  customPositions?: ErPositions
): string {
  const { nodes, edges } = buildGraph(tables, customPositions);
  if (nodes.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"></svg>`;
  }
  const posMap = new Map<string, { x: number; y: number; h: number; desc: TableDescription }>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const n of nodes) {
    const desc = (n.data as TableNodeData).desc;
    const h = nodeHeight(desc);
    const x = n.position.x;
    const y = n.position.y;
    posMap.set(n.id, { x, y, h, desc });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + NODE_WIDTH);
    maxY = Math.max(maxY, y + h);
  }

  const pad = 40;
  const width = Math.max(320, Math.ceil(maxX - minX + pad * 2));
  const height = Math.max(200, Math.ceil(maxY - minY + pad * 2));
  const ox = -minX + pad;
  const oy = -minY + pad;

  const lines: string[] = [];
  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" font-size="11">`
  );
  lines.push(
    `<rect width="100%" height="100%" fill="#0f172a" />`
  );

  // Render FK edges first so table cards sit above connectors
  for (const e of edges) {
    const src = posMap.get(e.source);
    const dst = posMap.get(e.target);
    if (!src || !dst) continue;
    const srcColName = (e.sourceHandle ?? "").replace(/^out:/, "");
    const dstColName = (e.targetHandle ?? "").replace(/^in:/, "");
    const srcIdx = Math.max(
      0,
      src.desc.columns.findIndex((c) => c.name === srcColName)
    );
    const dstIdx = Math.max(
      0,
      dst.desc.columns.findIndex((c) => c.name === dstColName)
    );
    const x1 = src.x + ox + NODE_WIDTH;
    const y1 = src.y + oy + HEADER_H + srcIdx * ROW_H + ROW_H / 2;
    const x2 = dst.x + ox;
    const y2 = dst.y + oy + HEADER_H + dstIdx * ROW_H + ROW_H / 2;
    const cx = (x1 + x2) / 2;
    lines.push(
      `<path d="M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}" fill="none" stroke="#64748b" stroke-width="1.5" />`
    );
    lines.push(`<circle cx="${x2}" cy="${y2}" r="3" fill="#38bdf8" />`);
  }

  // Render table nodes
  for (const [, item] of posMap) {
    const x = item.x + ox;
    const y = item.y + oy;
    const h = item.h;
    const { desc } = item;
    lines.push(`<g transform="translate(${x}, ${y})">`);
    lines.push(
      `<rect width="${NODE_WIDTH}" height="${h}" rx="8" fill="#1e293b" stroke="#334155" stroke-width="1" />`
    );
    lines.push(
      `<rect width="${NODE_WIDTH}" height="${HEADER_H}" rx="8" fill="#0f172a" />`
    );
    lines.push(
      `<line x1="0" y1="${HEADER_H}" x2="${NODE_WIDTH}" y2="${HEADER_H}" stroke="#334155" stroke-width="1" />`
    );
    lines.push(
      `<text x="12" y="20" fill="#f8fafc" font-weight="bold" font-size="12">${escapeXml(
        desc.name
      )}</text>`
    );
    desc.columns.forEach((col, idx) => {
      const cy = HEADER_H + idx * ROW_H;
      const badge = col.is_primary_key
        ? "PK"
        : desc.foreign_keys.some((f) => f.columns.includes(col.name))
        ? "FK"
        : "";
      const badgeColor = col.is_primary_key ? "#38bdf8" : "#34d399";
      if (badge) {
        lines.push(
          `<text x="10" y="${cy + 15}" fill="${badgeColor}" font-size="9" font-weight="bold">${badge}</text>`
        );
      }
      lines.push(
        `<text x="30" y="${cy + 15}" fill="#e2e8f0">${escapeXml(
          col.name
        )}</text>`
      );
      lines.push(
        `<text x="${NODE_WIDTH - 10}" y="${
          cy + 15
        }" fill="#7dd3fc" font-size="10" text-anchor="end">${escapeXml(
          col.data_type
        )}</text>`
      );
    });
    lines.push(`</g>`);
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

export function ERDiagram({
  tables,
  layoutKey,
  layoutResetVersion = 0,
  onPositionsChange,
}: {
  tables: TableDescription[];
  layoutKey?: string;
  layoutResetVersion?: number;
  onPositionsChange?: (positions: ErPositions) => void;
}) {
  const [hoverTable, setHoverTable] = useState<string | null>(null);
  const { theme } = useTheme();

  const { nodes, edges } = useMemo(
    () => buildGraph(tables, loadErPositions(layoutKey)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tables, layoutKey, layoutResetVersion]
  );
  const [localNodes, setLocalNodes] = useState<Node[]>(nodes);

  useEffect(() => {
    setLocalNodes(nodes);
    const map: ErPositions = {};
    for (const n of nodes) {
      map[n.id] = n.position;
    }
    onPositionsChange?.(map);
  }, [nodes, onPositionsChange]);

  const onNodesChange = useCallback(
    (changes: any) => {
      setLocalNodes((nds) => {
        let mutated = false;
        const next = nds.map((n) => {
          const ch = changes.find((c: any) => c.id === n.id);
          if (ch?.type === "position" && ch.position) {
            mutated = true;
            return { ...n, position: ch.position };
          }
          return n;
        });
        if (mutated) {
          const saved = loadErPositions(layoutKey);
          for (const n of next) {
            saved[n.id] = n.position;
          }
          saveErPositions(layoutKey, saved);
          onPositionsChange?.(saved);
        }
        return next;
      });
    },
    [layoutKey, onPositionsChange]
  );

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
        colorMode={theme}
        nodesConnectable={false}
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
          nodeColor={() => "hsl(var(--brand) / 0.6)"}
          maskColor="hsl(var(--background) / 0.7)"
          className="!h-[120px] !w-[180px] overflow-hidden rounded-lg border border-border !bg-surface-elevated"
        />
        <Controls
          showInteractive={false}
          className="overflow-hidden rounded-lg border border-border !shadow-soft"
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
            className="relative flex h-[22px] items-center gap-1.5 px-3"
            title={`${c.name} ${c.data_type}${c.nullable ? "" : " NOT NULL"}`}
          >
            {/* Per-column anchors: FK edges leave the referencing column and
                land on the referenced one, Navicat-style. */}
            <Handle
              type="target"
              id={columnHandle("in", c.name)}
              position={Position.Left}
              isConnectable={false}
              className="!h-1.5 !w-1.5 !min-w-0 !border-0 !bg-transparent"
            />
            <Handle
              type="source"
              id={columnHandle("out", c.name)}
              position={Position.Right}
              isConnectable={false}
              className="!h-1.5 !w-1.5 !min-w-0 !border-0 !bg-transparent"
            />
            {c.is_primary_key ? (
              <KeyRound className="h-2.5 w-2.5 shrink-0 text-brand" />
            ) : desc.foreign_keys.some((f) => f.columns.includes(c.name)) ? (
              <Link2 className="h-2.5 w-2.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
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
            <span className="truncate font-mono text-[10px] text-sky-600 dark:text-sky-300">
              {c.data_type}
            </span>
            {/* MySQL Workbench / Navicat convention: filled = NOT NULL. */}
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rotate-45",
                c.nullable ? "border border-muted-foreground/60" : "bg-muted-foreground"
              )}
            />
          </li>
        ))}
      </ul>
      <div className="h-3 bg-surface-muted/40" />
    </div>
  );
}

function columnHandle(side: "in" | "out", column: string) {
  return `${side}:${column}`;
}

export function buildGraph(
  tables: TableDescription[],
  customPositions?: ErPositions
): {
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
          sourceHandle: columnHandle("out", fk.columns[0]),
          targetHandle: columnHandle("in", fk.referenced_columns[0] ?? fk.columns[0]),
          type: "smoothstep",
          label: fk.columns.join(","),
          labelStyle: { fontSize: 10, fill: "hsl(var(--muted-foreground))" },
        });
      }
    }
  }
  dagre.layout(g);

  const nodes: Node[] = tables.map((t) => {
    const saved = customPositions?.[t.name];
    const n = g.node(t.name);
    return {
      id: t.name,
      type: "table",
      data: { desc: t },
      position: saved
        ? { x: saved.x, y: saved.y }
        : {
            x: (n?.x ?? 0) - NODE_WIDTH / 2,
            y: (n?.y ?? 0) - nodeHeight(t) / 2,
          },
    };
  });

  return { nodes, edges };
}
