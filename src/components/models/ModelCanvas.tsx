import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, BackgroundVariant, BaseEdge, Controls, Handle, Position, applyNodeChanges, getBezierPath, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "@/components/theme/ThemeProvider";
import { FitVisibleGraph } from "@/components/er/FitVisibleGraph";
import { modelSelfRelationSpace, type OfflineModel, type ModelTable } from "@/lib/offlineModel";
import { useT } from "@/store/i18n";

type TableNode = Node<{ table: ModelTable; selfRelations: number }>;
function TableCard({ data, selected }: NodeProps<TableNode>) {
  const { table } = data;
  return <div className="w-60" style={{ paddingTop: modelSelfRelationSpace(data.selfRelations) }}><div className={`relative rounded-lg border bg-surface shadow-soft ${selected ? "border-brand ring-1 ring-brand" : "border-border"}`}>
    <Handle id="main-target" type="target" position={Position.Top} />
    <Handle id="self-source" type="source" position={Position.Top} style={{ left: "30%" }} />
    <Handle id="self-target" type="target" position={Position.Top} style={{ left: "70%" }} />
    <div className="border-b border-border bg-surface-muted px-3 py-2"><p className="truncate text-[10px] text-muted-foreground">{table.schema || "—"}</p><p className="truncate text-sm font-semibold" title={table.name}>{table.name}</p></div>
    <div className="divide-y divide-border/40">{table.columns.slice(0, 12).map(c => <div key={c.id} className="flex gap-2 px-3 py-1 text-xs" title={`${c.name} · ${c.type}${c.comment ? " · " + c.comment : ""}`}><span className="w-4 shrink-0 text-[9px] text-brand">{c.primaryKey ? "PK" : (c.unique || table.uniqueKeys?.some(k => k.columns.includes(c.id))) ? "UQ" : ""}</span><span className="min-w-0 flex-1 truncate">{c.name}</span><span className="max-w-24 truncate font-mono text-muted-foreground">{c.type}{c.nullable ? "?" : ""}</span></div>)}</div>
    {table.columns.length > 12 && <div className="px-3 py-1 text-xs text-muted-foreground">+ {table.columns.length - 12}</div>}
    <Handle id="main-source" type="source" position={Position.Bottom} />
  </div></div>;
}
const nodeTypes = { table: TableCard };
function RelationEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, data } = props;
  const count = typeof data?.count === "number" ? data.count : 1;
  let [path, labelX, labelY] = getBezierPath(props);
  if (count > 1) {
    const lane = typeof data?.lane === "number" ? data.lane : 0;
    const offset = (lane - (count - 1) / 2) * 40;
    const curve = Math.max(50, Math.abs(targetY - sourceY) / 2, Math.abs(offset) + 30);
    path = `M ${sourceX},${sourceY} C ${sourceX + offset},${sourceY + curve + offset} ${targetX + offset},${targetY - curve + offset} ${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2 + offset * 0.75;
    labelY = (sourceY + targetY) / 2 + offset * 0.75;
  }
  return <BaseEdge id={props.id} path={path} style={props.style} label={props.label} labelX={labelX} labelY={labelY} labelStyle={props.labelStyle} labelBgStyle={props.labelBgStyle} />;
}
function SelfRelationEdge({ id, sourceX, sourceY, targetX, targetY, style, label, labelStyle, labelBgStyle, data }: EdgeProps) {
  // The default top-to-bottom self edge runs through its own table card.
  const depth = modelSelfRelationSpace(typeof data?.lane === "number" ? data.lane + 1 : 1);
  const top = Math.min(sourceY, targetY) - depth;
  return <BaseEdge id={id} path={`M ${sourceX},${sourceY} C ${sourceX},${top} ${targetX},${top} ${targetX},${targetY}`} style={style}
    label={label} labelX={(sourceX + targetX) / 2} labelY={top + depth / 4} labelStyle={labelStyle} labelBgStyle={labelBgStyle} />;
}
const edgeTypes = { self: SelfRelationEdge, relation: RelationEdge };
export function ModelCanvas({ model, active, busy, selected, layoutVersion, onSelect, onEdit, onMove }: {
  model: OfflineModel; layoutVersion: number; active: boolean; busy: boolean; selected: string | null;
  onSelect: (id: string) => void; onEdit: (id: string) => void; onMove: (id: string, position: { x: number; y: number }) => Promise<boolean>;
}) {
  const { theme } = useTheme(), t = useT(), container = useRef<HTMLDivElement>(null);
  const selfCounts = useMemo(() => { const counts = new Map<string, number>(); for (const r of model.relations) if (r.fromTable === r.toTable) counts.set(r.fromTable, (counts.get(r.fromTable) ?? 0) + 1); return counts; }, [model.relations]);
  const [nodes, setNodes] = useState<TableNode[]>(() => model.tables.map(table => ({ id: table.id, type: "table", position: table.position, data: { table, selfRelations: selfCounts.get(table.id) ?? 0 } })));
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => setNodes(previous => model.tables.map(table => ({ ...previous.find(n => n.id === table.id), id: table.id, type: "table", position: table.position, selected: table.id === selected, data: { table, selfRelations: selfCounts.get(table.id) ?? 0 } }))), [model, selected, selfCounts]);
  const edges = useMemo(() => {
    const lanes = new Map<string, number>(), counts = new Map<string, number>();
    const group = (a: string, b: string) => JSON.stringify([a, b].sort());
    for (const r of model.relations) { const key = group(r.fromTable, r.toTable); counts.set(key, (counts.get(key) ?? 0) + 1); }
    return model.relations.map(r => {
    const key = group(r.fromTable, r.toTable), lane = lanes.get(key) ?? 0;
    lanes.set(key, lane + 1);
    return { id: r.id, source: r.toTable, target: r.fromTable,
      data: { lane, count: counts.get(key) ?? 1 },
      ...(r.fromTable === r.toTable ? { type: "self", sourceHandle: "self-source", targetHandle: "self-target" } : { type: "relation", sourceHandle: "main-source", targetHandle: "main-target" }),
      label: `${r.name} · ${r.cardinality === "one-one" ? "1:1" : "1:N"}`, selected: r.id === selected, style: { stroke: r.id === selected ? "hsl(var(--brand))" : "hsl(var(--muted-foreground))", strokeDasharray: r.identifying ? undefined : "5 4" }, labelStyle: { fill: "hsl(var(--foreground))", fontSize: 11 }, labelBgStyle: { fill: "hsl(var(--surface))" } };
  }); }, [model.relations, selected]);
  // A document change may alter node geometry; do not refit for drag/selection.
  const shape = model.tables.map(t => `${t.id}:${t.columns.length}:${selfCounts.get(t.id) ?? 0}`).join("|");
  const revision = useMemo(() => ({}), [shape, layoutVersion]);
  return <div ref={container} className="relative min-h-0 flex-1" aria-label={t("model.title")}>
    {!model.tables.length && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center p-8 text-center text-sm text-muted-foreground">{t("model.no_tables")}</div>}
    <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} colorMode={theme} nodesConnectable={false} nodesDraggable={!busy} elementsSelectable={!busy} deleteKeyCode={null} disableKeyboardA11y minZoom={0.005} maxZoom={2} proOptions={{ hideAttribution: true }}
      onNodesChange={changes => setNodes(previous => applyNodeChanges(changes, previous))}
      onNodeClick={(_, n) => { if (!busy) onSelect(n.id); }} onNodeDoubleClick={(_, n) => { if (!busy) onEdit(n.id); }} onEdgeClick={(_, e) => { if (!busy) onSelect(e.id); }}
      onNodeDragStop={async (_, node) => { const saved = await onMove(node.id, node.position); if (!saved && alive.current) setNodes(previous => previous.map(n => ({ ...n, position: model.tables.find(t => t.id === n.id)?.position ?? n.position }))); }}>
      <FitVisibleGraph active={active} container={container} revision={revision} minZoom={0.005} />
      <Background variant={BackgroundVariant.Dots} color="hsl(var(--border))" gap={20} />
      <Controls showInteractive={false} />
    </ReactFlow>
  </div>;
}
