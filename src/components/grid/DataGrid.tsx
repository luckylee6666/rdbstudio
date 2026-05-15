import { useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, Clipboard, X } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";

export interface GridColumn {
  name: string;
  data_type?: string;
}

interface Props {
  columns: GridColumn[];
  rows: unknown[][];
  emptyMessage?: string;
}

interface CellSel {
  row: number;
  col: number;
}

const MIN_COL_WIDTH = 60;
const DEFAULT_COL_WIDTH = 160;
const ROW_HEIGHT = 26;

export function DataGrid({ columns, rows, emptyMessage = "No rows" }: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() =>
    columns.map(() => DEFAULT_COL_WIDTH)
  );
  const [selected, setSelected] = useState<CellSel | null>(null);
  const [viewer, setViewer] = useState<CellSel | null>(null);

  // keep widths in sync if columns change length
  useMemo(() => {
    setWidths((prev) => {
      if (prev.length === columns.length) return prev;
      return columns.map((_, i) => prev[i] ?? DEFAULT_COL_WIDTH);
    });
  }, [columns.length]);

  const totalWidth = useMemo(
    () => widths.reduce((a, b) => a + b, 40),
    [widths]
  );

  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const startResize = (
    e: React.MouseEvent,
    index: number
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[index];
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX));
      setWidths((w) => {
        const copy = w.slice();
        copy[index] = next;
        return copy;
      });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div
      ref={parentRef}
      className="h-full w-full overflow-auto bg-background text-[12.5px]"
    >
      <div style={{ width: totalWidth, minWidth: "100%" }}>
        <div
          className="sticky top-0 z-10 flex h-7 items-stretch border-b border-border/80 bg-surface/95 backdrop-blur"
          style={{ width: totalWidth }}
        >
          <div
            className="sticky left-0 z-20 w-10 shrink-0 border-r border-border/80 bg-surface/95 text-right"
            style={{ lineHeight: "28px" }}
          >
            <span className="pr-1.5 text-[11px] text-muted-foreground">#</span>
          </div>
          {columns.map((c, i) => (
            <div
              key={i}
              className="relative flex items-center gap-1.5 border-r border-border/80 px-2 font-medium"
              style={{ width: widths[i] }}
            >
              <span className="truncate">{c.name}</span>
              {c.data_type && (
                <span className="rounded bg-surface-muted px-1 text-[10px] font-normal text-muted-foreground">
                  {c.data_type.toLowerCase()}
                </span>
              )}
              <div
                onMouseDown={(e) => startResize(e, i)}
                className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-brand/40"
              />
            </div>
          ))}
        </div>

        {rows.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-[12px] text-muted-foreground">
            {emptyMessage}
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
                    "absolute left-0 flex items-stretch border-b border-border/60 hover:bg-accent/30"
                  )}
                  style={{
                    top: vr.start,
                    height: ROW_HEIGHT,
                    width: totalWidth,
                  }}
                >
                  <div
                    className="sticky left-0 z-[1] w-10 shrink-0 border-r border-border/60 bg-background px-2 text-right text-[11px] leading-[26px] text-muted-foreground"
                  >
                    {vr.index + 1}
                  </div>
                  {columns.map((_, i) => (
                    <Cell
                      key={i}
                      width={widths[i]}
                      value={row?.[i]}
                      selected={
                        selected?.row === vr.index && selected?.col === i
                      }
                      onClick={() => setSelected({ row: vr.index, col: i })}
                      onDoubleClick={() => setViewer({ row: vr.index, col: i })}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {viewer && (
        <CellViewer
          column={columns[viewer.col]}
          value={rows[viewer.row]?.[viewer.col]}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
}

function Cell({
  width,
  value,
  selected,
  onClick,
  onDoubleClick,
}: {
  width: number;
  value: unknown;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
}) {
  const isNull = value === null || value === undefined;
  const isNumeric = typeof value === "number" || typeof value === "bigint";
  const display = isNull
    ? "NULL"
    : typeof value === "string"
    ? value
    : typeof value === "boolean"
    ? value
      ? "true"
      : "false"
    : JSON.stringify(value);
  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "flex cursor-default select-text items-center overflow-hidden border-r border-border/60 px-2 font-mono leading-[26px]",
        isNumeric && "justify-end tabular-nums",
        isNull && "italic text-muted-foreground/50",
        selected && "bg-brand/15 outline outline-1 -outline-offset-1 outline-brand/60"
      )}
      style={{ width, height: ROW_HEIGHT }}
      title={display}
    >
      <span className="truncate">{display}</span>
    </div>
  );
}

function CellViewer({
  column,
  value,
  onClose,
}: {
  column?: GridColumn;
  value: unknown;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [pretty, setPretty] = useState(true);

  const raw =
    value === null || value === undefined
      ? "NULL"
      : typeof value === "string"
      ? value
      : typeof value === "boolean"
      ? String(value)
      : JSON.stringify(value);

  // Try to parse as JSON for pretty-printing if string content looks JSONish
  // or value was already a non-primitive — gives the user a "pretty" toggle.
  const prettyText = useMemo(() => {
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return raw;
      }
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          return JSON.stringify(JSON.parse(trimmed), null, 2);
        } catch {
          return value;
        }
      }
      return value;
    }
    return raw;
  }, [value, raw]);

  const text = pretty ? prettyText : raw;
  const canPretty = prettyText !== raw;

  const onCopy = async () => {
    const ok = await copyText(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  };

  const isNull = value === null || value === undefined;
  const typeLabel =
    isNull ? "null" : typeof value === "object" ? "object" : typeof value;
  const byteLen = new Blob([text]).size;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative flex max-h-[80vh] w-[720px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border/80 bg-surface-elevated shadow-elevated">
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="truncate text-[13.5px] font-medium">
              {column?.name ?? "value"}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {column?.data_type ?? typeLabel} · {byteLen.toLocaleString()} bytes
            </div>
          </div>
          {canPretty && (
            <button
              onClick={() => setPretty((p) => !p)}
              className="rounded-md border border-border/70 bg-surface px-2 py-1 text-[11px] hover:bg-accent"
            >
              {pretty ? "Raw" : "Pretty"}
            </button>
          )}
          <button
            onClick={onCopy}
            className="flex items-center gap-1 rounded-md border border-border/70 bg-surface px-2 py-1 text-[11px] hover:bg-accent"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" /> Copied
              </>
            ) : (
              <>
                <Clipboard className="h-3 w-3" /> Copy
              </>
            )}
          </button>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre
          className={cn(
            "min-h-[180px] flex-1 overflow-auto whitespace-pre-wrap break-words bg-background p-4 font-mono text-[12.5px] leading-[1.55]",
            isNull && "italic text-muted-foreground"
          )}
        >
          {text}
        </pre>
      </div>
    </div>,
    document.body
  );
}
