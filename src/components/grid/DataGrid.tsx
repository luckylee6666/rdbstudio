import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Braces, Check, Clipboard, FileText, Terminal, X } from "lucide-react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { toCSV } from "@/lib/csv";
import { toInsertSql, toJSONRows } from "@/lib/rowcopy";
import { ContextMenu, type MenuEntry } from "@/components/ui/ContextMenu";
import { useT } from "@/store/i18n";
import type { DriverKind } from "@/types";

export interface GridColumn {
  name: string;
  data_type?: string;
}

interface Props {
  columns: GridColumn[];
  rows: unknown[][];
  emptyMessage?: string;
  /** Table name used by "Copy row as INSERT" (falls back to "my_table"). */
  tableName?: string;
  /** Driver for identifier quoting in generated INSERTs. */
  driver?: DriverKind;
}

interface CellSel {
  row: number;
  col: number;
}

/** Cell value as the same text the grid shows (NULL for null). */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

const MIN_COL_WIDTH = 60;
const DEFAULT_COL_WIDTH = 160;
const ROW_HEIGHT = 26;

export function DataGrid({
  columns,
  rows,
  emptyMessage,
  tableName,
  driver,
}: Props) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<number[]>(() =>
    columns.map(() => DEFAULT_COL_WIDTH)
  );
  const [selected, setSelected] = useState<CellSel | null>(null);
  const [viewer, setViewer] = useState<CellSel | null>(null);
  const [ctx, setCtx] = useState<(CellSel & { x: number; y: number }) | null>(
    null
  );
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const t = useT();

  useEffect(
    () => () => {
      resizeCleanupRef.current?.();
    },
    []
  );

  const copyMenu = (sel: CellSel): MenuEntry[] => {
    const row = rows[sel.row] ?? [];
    const names = columns.map((c) => c.name);
    return [
      {
        id: "copy-cell",
        label: t("grid.copy_cell"),
        icon: Clipboard,
        onClick: () => void copyText(cellText(row[sel.col])),
      },
      { id: "sep", label: "", separator: true },
      {
        id: "copy-insert",
        label: t("grid.copy_insert"),
        icon: Terminal,
        onClick: () =>
          void copyText(
            toInsertSql(driver, tableName ?? "my_table", names, [row])
          ),
      },
      {
        id: "copy-csv",
        label: t("grid.copy_csv"),
        icon: FileText,
        onClick: () => void copyText(toCSV(names, [row])),
      },
      {
        id: "copy-json",
        label: t("grid.copy_json"),
        icon: Braces,
        onClick: () => void copyText(toJSONRows(names, [row])),
      },
    ];
  };

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
    resizeCleanupRef.current?.();
    const startX = e.clientX;
    const startW = widths[index];
    let latestX = startX;
    let frame: number | null = null;
    const applyWidth = () => {
      frame = null;
      const next = Math.max(MIN_COL_WIDTH, startW + (latestX - startX));
      setWidths((w) => {
        const copy = w.slice();
        copy[index] = next;
        return copy;
      });
    };
    const onMove = (ev: MouseEvent) => {
      latestX = ev.clientX;
      if (frame == null) frame = window.requestAnimationFrame(applyWidth);
    };
    const cleanup = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("blur", cleanup);
      if (frame != null) window.cancelAnimationFrame(frame);
      frame = null;
      if (resizeCleanupRef.current === cleanup) resizeCleanupRef.current = null;
    };
    const onUp = (ev: MouseEvent) => {
      latestX = ev.clientX;
      if (frame != null) window.cancelAnimationFrame(frame);
      applyWidth();
      cleanup();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("blur", cleanup);
    resizeCleanupRef.current = cleanup;
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
            {emptyMessage ?? t("grid.no_rows")}
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
                      onContextMenu={(e) => {
                        e.preventDefault();
                        setSelected({ row: vr.index, col: i });
                        setCtx({
                          row: vr.index,
                          col: i,
                          x: e.clientX,
                          y: e.clientY,
                        });
                      }}
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
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={copyMenu(ctx)}
          onClose={() => setCtx(null)}
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
  onContextMenu,
}: {
  width: number;
  value: unknown;
  selected?: boolean;
  onClick?: () => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
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
      onContextMenu={onContextMenu}
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
  const t = useT();
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
              {column?.name ?? t("grid.viewer.value")}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {column?.data_type ?? typeLabel} ·{" "}
              {t("grid.viewer.bytes", { n: byteLen.toLocaleString() })}
            </div>
          </div>
          {canPretty && (
            <button
              onClick={() => setPretty((p) => !p)}
              className="rounded-md border border-border/70 bg-surface px-2 py-1 text-[11px] hover:bg-accent"
            >
              {pretty ? t("grid.viewer.raw") : t("grid.viewer.pretty")}
            </button>
          )}
          <button
            onClick={onCopy}
            className="flex items-center gap-1 rounded-md border border-border/70 bg-surface px-2 py-1 text-[11px] hover:bg-accent"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" /> {t("common.copied")}
              </>
            ) : (
              <>
                <Clipboard className="h-3 w-3" /> {t("common.copy")}
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
