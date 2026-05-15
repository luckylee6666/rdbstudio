import { useCallback, useMemo, useRef, useState, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { ColumnInfo, OrderBy } from "@/types";

export interface GridRow {
  key: string;
  values: unknown[];
  kind: "existing" | "insert";
  dirtyCols?: Set<number>;
  deleted?: boolean;
  originalValues?: unknown[];
}

interface Props {
  columns: ColumnInfo[];
  rows: GridRow[];
  order?: OrderBy;
  editable: boolean;
  onSortClick: (col: string) => void;
  onCellEdit: (rowKey: string, colIndex: number, value: unknown) => void;
  onRowRevert: (rowKey: string) => void;
  onRowDelete: (rowKey: string) => void;
}

const MIN_COL_WIDTH = 80;
const DEFAULT_COL_WIDTH = 160;
const ROW_HEIGHT = 28;

export function TableDataGrid({
  columns,
  rows,
  order,
  editable,
  onSortClick,
  onCellEdit,
  onRowRevert,
  onRowDelete,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() =>
    columns.map(() => DEFAULT_COL_WIDTH)
  );
  const [editing, setEditing] = useState<{ row: string; col: number } | null>(
    null
  );

  useEffect(() => {
    setWidths((prev) =>
      columns.map((_, i) => prev[i] ?? DEFAULT_COL_WIDTH)
    );
  }, [columns.length]);

  const totalWidth = useMemo(
    () => widths.reduce((a, b) => a + b, 0) + 96,
    [widths]
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const startResize = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = widths[index];
      const onMove = (ev: MouseEvent) => {
        const next = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX));
        setWidths((w) => {
          const c = w.slice();
          c[index] = next;
          return c;
        });
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [widths]
  );

  return (
    <div
      ref={parentRef}
      className="h-full w-full overflow-auto bg-background text-[12.5px]"
    >
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        {/* Header */}
        <div
          className="sticky top-0 z-20 flex h-8 items-stretch border-b border-border/80 bg-surface/95 backdrop-blur"
          style={{ width: totalWidth }}
        >
          <CornerCell />
          {columns.map((c, i) => (
            <HeaderCell
              key={c.name}
              col={c}
              width={widths[i]}
              order={order?.column === c.name ? order.direction : undefined}
              onClick={() => onSortClick(c.name)}
              onResizeStart={(e) => startResize(e, i)}
            />
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-[12px] text-muted-foreground">
            No rows.
          </div>
        ) : (
          <div
            style={{
              height: rowVirtualizer.getTotalSize(),
              position: "relative",
              width: totalWidth,
            }}
          >
            {rowVirtualizer.getVirtualItems().map((vr) => {
              const row = rows[vr.index];
              return (
                <div
                  key={vr.key}
                  className={cn(
                    "absolute left-0 flex items-stretch border-b border-border/60",
                    row.kind === "insert" && "bg-emerald-500/5",
                    row.deleted && "bg-rose-500/10 opacity-60"
                  )}
                  style={{
                    top: vr.start,
                    height: ROW_HEIGHT,
                    width: totalWidth,
                  }}
                >
                  <RowNumberCell
                    index={vr.index}
                    row={row}
                    editable={editable}
                    onRevert={() => onRowRevert(row.key)}
                    onDelete={() => onRowDelete(row.key)}
                  />
                  {columns.map((c, i) => {
                    const cellEditable =
                      !row.deleted &&
                      (row.kind === "insert" || editable);
                    return (
                      <EditableCell
                        key={c.name}
                        column={c}
                        width={widths[i]}
                        value={row.values[i]}
                        editing={
                          editing?.row === row.key && editing?.col === i
                        }
                        dirty={row.dirtyCols?.has(i) ?? false}
                        isInsert={row.kind === "insert"}
                        deleted={row.deleted}
                        readOnly={!cellEditable}
                        onStartEdit={() => {
                          if (!cellEditable) return;
                          setEditing({ row: row.key, col: i });
                        }}
                        onStopEdit={() => setEditing(null)}
                        onCommit={(v) => {
                          setEditing(null);
                          onCellEdit(row.key, i, v);
                        }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function CornerCell() {
  return (
    <div className="sticky left-0 z-[21] w-24 shrink-0 border-r border-border/80 bg-surface/95" />
  );
}

function HeaderCell({
  col,
  width,
  order,
  onClick,
  onResizeStart,
}: {
  col: ColumnInfo;
  width: number;
  order?: "asc" | "desc";
  onClick: () => void;
  onResizeStart: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      className="group relative flex items-center gap-1.5 border-r border-border/80 font-medium"
      style={{ width }}
    >
      <button
        onClick={onClick}
        className="flex flex-1 items-center gap-1.5 px-2 py-1 text-left hover:bg-accent/40"
      >
        <span className="truncate">{col.name}</span>
        {col.is_primary_key && (
          <span className="rounded bg-brand/20 px-1 text-[9.5px] font-semibold uppercase text-brand">
            pk
          </span>
        )}
        {!col.nullable && !col.is_primary_key && (
          <span className="text-[10px] text-muted-foreground">!</span>
        )}
        <span className="ml-auto text-muted-foreground">
          {order === "asc" ? (
            <ArrowUp className="h-3 w-3 text-brand" />
          ) : order === "desc" ? (
            <ArrowDown className="h-3 w-3 text-brand" />
          ) : (
            <ArrowUpDown className="h-3 w-3 opacity-0 group-hover:opacity-60" />
          )}
        </span>
      </button>
      <div
        onMouseDown={onResizeStart}
        className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-brand/40"
      />
    </div>
  );
}

function RowNumberCell({
  index,
  row,
  editable,
  onRevert,
  onDelete,
}: {
  index: number;
  row: GridRow;
  editable: boolean;
  onRevert: () => void;
  onDelete: () => void;
}) {
  const dirty = (row.dirtyCols?.size ?? 0) > 0 || row.kind === "insert";
  return (
    <div
      className={cn(
        "sticky left-0 z-[1] flex w-24 shrink-0 items-center gap-1 border-r border-border/60 bg-background px-1.5 text-[11px] text-muted-foreground",
        dirty && "bg-amber-500/5"
      )}
      style={{ height: ROW_HEIGHT }}
    >
      <span className="w-8 text-right tabular-nums">
        {row.kind === "insert" ? "+" : index + 1}
      </span>
      {dirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
      {editable && (
        <div className="ml-auto flex items-center opacity-0 group-hover:opacity-100 hover:opacity-100">
          {(row.dirtyCols?.size ?? 0) > 0 || row.deleted ? (
            <button
              onClick={onRevert}
              title="Revert"
              className="grid h-4 w-4 place-items-center rounded hover:bg-accent"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          ) : null}
          <button
            onClick={onDelete}
            title={row.deleted ? "Undo delete" : "Delete row"}
            className="grid h-4 w-4 place-items-center rounded hover:bg-accent"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}

function EditableCell({
  column,
  width,
  value,
  editing,
  dirty,
  isInsert,
  deleted,
  readOnly,
  onStartEdit,
  onStopEdit,
  onCommit,
}: {
  column: ColumnInfo;
  width: number;
  value: unknown;
  editing: boolean;
  dirty: boolean;
  isInsert: boolean;
  deleted?: boolean;
  readOnly: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onCommit: (v: unknown) => void;
}) {
  const isNull = value === null || value === undefined;
  const isNumeric = /int|numeric|decimal|float|double|real/i.test(
    column.data_type
  );
  const display = isNull
    ? "NULL"
    : typeof value === "string"
    ? value
    : typeof value === "boolean"
    ? String(value)
    : JSON.stringify(value);

  if (editing) {
    return (
      <CellInput
        initial={isNull ? "" : display}
        width={width}
        onCommit={(text) => {
          if (text === "" && column.nullable) onCommit(null);
          else if (isNumeric && text !== "") {
            const n = Number(text);
            onCommit(Number.isNaN(n) ? text : n);
          } else onCommit(text);
        }}
        onCancel={onStopEdit}
      />
    );
  }

  return (
    <div
      onDoubleClick={onStartEdit}
      className={cn(
        "flex items-center overflow-hidden border-r border-border/60 px-2 font-mono",
        isNumeric && "justify-end tabular-nums",
        isNull && "italic text-muted-foreground/50",
        dirty && "bg-amber-500/10",
        isInsert && !dirty && "text-emerald-300",
        deleted && "line-through",
        !readOnly && "cursor-cell"
      )}
      style={{ width, height: ROW_HEIGHT }}
      title={isNull ? "NULL" : display}
    >
      <span className="truncate">{display}</span>
    </div>
  );
}

function CellInput({
  initial,
  width,
  onCommit,
  onCancel,
}: {
  initial: string;
  width: number;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <div
      className="flex items-stretch border-r border-border/60 bg-surface-elevated"
      style={{ width, height: ROW_HEIGHT }}
    >
      <input
        ref={ref}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => onCommit(val)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit(val);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="w-full border-0 bg-transparent px-2 font-mono text-[12.5px] outline-none ring-1 ring-brand/60"
      />
    </div>
  );
}
