import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  KeyRound,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { base64ByteLength, formatBytes, isBinaryType, sniffBinary } from "@/lib/binary";
import { cn } from "@/lib/cn";
import { useElementWidth } from "@/lib/useElementWidth";
import { useT } from "@/store/i18n";
import type { ColumnInfo } from "@/types";
import type { GridRow } from "./TableDataGrid";

export { isBinaryType };

export const MAX_BINARY_EDIT_BYTES = 8 * 1024 * 1024;
const MAX_BINARY_BASE64_CHARS = Math.ceil(MAX_BINARY_EDIT_BYTES / 3) * 4;
export function binaryPayloadExceedsEditLimit(base64: string): boolean {
  // Encoded lengths can collide at a byte boundary (8 MiB and 8 MiB + 1
  // both use the same number of base64 characters). Reject obvious oversize
  // payloads first, then calculate decoded length without allocating bytes.
  if (base64.length > MAX_BINARY_BASE64_CHARS) return true;
  return base64ByteLength(base64) > MAX_BINARY_EDIT_BYTES;
}

function base64Value(value: unknown): string {
  if (value && typeof value === "object" && "$binary" in value) return String((value as { $binary: string }).$binary);
  return typeof value === "string" ? value : "";
}

export function hexFromBase64(value: string): string {
  const binary = atob(value);
  const digits = "0123456789abcdef";
  const chunks: string[] = [];
  // Avoid Array.from(binary) for multi-megabyte values: it creates millions of
  // temporary strings before allocating the final hexadecimal representation.
  const bytesPerChunk = 4096;
  for (let start = 0; start < binary.length; start += bytesPerChunk) {
    const end = Math.min(start + bytesPerChunk, binary.length);
    const part = new Array<string>(end - start);
    for (let i = start; i < end; i++) {
      const byte = binary.charCodeAt(i);
      part[i - start] = digits[(byte >> 4) & 15] + digits[byte & 15];
    }
    chunks.push(part.join(" "));
  }
  return chunks.join(" ");
}

export function base64FromHex(hex: string): string {
  const compact = hex.replace(/\s/g, "");
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(compact)) throw new Error("Hex must contain pairs of hexadecimal digits");
  if (compact.length > MAX_BINARY_EDIT_BYTES * 2) throw new Error("Binary values must be at most 8 MiB");
  let binary = "";
  for (let i = 0; i < compact.length; i += 2) binary += String.fromCharCode(parseInt(compact.slice(i, i + 2), 16));
  return btoa(binary);
}

const INTEGER = /^(integer|int|smallint|bigint|tinyint|mediumint)/i;
const FLOAT = /^(real|float|double)/i;
const NUMERIC = /^(int|smallint|bigint|tinyint|mediumint|real|float|double|numeric|decimal)/i;

function emptyValueFor(column: ColumnInfo): unknown {
  if (isBinaryType(column.data_type)) return { $binary: "" };
  if (/^(bool|bit)/i.test(column.data_type)) return false;
  if (NUMERIC.test(column.data_type)) return 0;
  return "";
}

function BinaryField({ value, editable, onEdit }: { value: unknown; editable: boolean; onEdit: (value: unknown) => void }) {
  const t = useT();
  const editableRef = useRef(editable);
  editableRef.current = editable;
  const [hex, setHex] = useState("");
  const [error, setError] = useState("");
  const encoded = base64Value(value);
  const tooLarge = binaryPayloadExceedsEditLimit(encoded);
  const kind = sniffBinary(encoded);
  const size = base64ByteLength(encoded);

  useEffect(() => {
    if (tooLarge) {
      setHex("");
      setError(t("form.binary.too_large"));
      return;
    }
    try {
      setHex(hexFromBase64(encoded));
      setError("");
    } catch {
      setHex("");
      setError(t("form.binary.undecodable"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encoded, tooLarge]);

  const load = async () => {
    try {
      const path = await open({ multiple: false });
      if (typeof path === "string") {
        const data = await invoke<string>("read_binary_file", { path });
        if (editableRef.current) onEdit({ $binary: data });
      }
    } catch (e) {
      setError(String(e));
    }
  };
  const exportFile = async () => {
    try {
      const ext = kind?.label.toLowerCase() ?? "bin";
      const path = await save({ defaultPath: `value.${ext === "jpeg" ? "jpg" : ext}` });
      if (path) await invoke("write_binary_file", { path, base64Data: encoded });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
          {kind?.label ?? "BLOB"} · {formatBytes(size)}
        </span>
        <div className="flex-1" />
        <Button size="sm" disabled={!editable || tooLarge} onClick={() => void load()}>
          <FileUp className="h-3.5 w-3.5" />
          {t("form.binary.load")}
        </Button>
        <Button size="sm" disabled={tooLarge || !encoded} onClick={() => void exportFile()}>
          <Download className="h-3.5 w-3.5" />
          {t("form.binary.save")}
        </Button>
      </div>
      {!tooLarge && kind?.mime.startsWith("image/") && (
        <div className="inline-flex rounded-lg border border-border/60 bg-[conic-gradient(hsl(var(--muted))_25%,transparent_0_50%,hsl(var(--muted))_0_75%,transparent_0)] bg-[length:16px_16px] p-2">
          <img
            src={`data:${kind.mime};base64,${encoded}`}
            alt={t("form.binary.preview")}
            className="max-h-64 max-w-full object-contain [image-rendering:pixelated]"
            style={{ minWidth: 48, minHeight: 48 }}
          />
        </div>
      )}
      <textarea
        aria-label="Hexadecimal content"
        value={hex}
        disabled={!editable || tooLarge}
        rows={Math.min(8, Math.max(3, Math.ceil(hex.length / 96)))}
        spellCheck={false}
        onChange={(e) => setHex(e.target.value)}
        onBlur={() => {
          if (!editable || tooLarge) return;
          try {
            const next = base64FromHex(hex);
            if (next !== encoded) onEdit({ $binary: next });
            setError("");
          } catch (e) {
            setError(String(e));
          }
        }}
        className="w-full resize-y rounded-md border border-border/70 bg-background/60 p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground/90 focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60"
      />
      {error && <p role="alert" className="text-[11.5px] text-danger">{error}</p>}
    </div>
  );
}

function FieldEditor({ column, value, editable, onEdit }: { column: ColumnInfo; value: unknown; editable: boolean; onEdit: (value: unknown) => void }) {
  const t = useT();
  const text = value == null ? "" : typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(text);
  }, [text]);

  const commit = () => {
    if (!editable || draft === text) return;
    try {
      let parsed: unknown = draft;
      if (INTEGER.test(column.data_type)) {
        if (!/^-?\d+$/.test(draft)) throw new Error(t("form.err.integer"));
        const number = BigInt(draft);
        parsed = number >= -9007199254740991n && number <= 9007199254740991n ? Number(number) : draft;
      } else if (FLOAT.test(column.data_type)) {
        if (!draft.trim() || !Number.isFinite(Number(draft))) throw new Error(t("form.err.number"));
        parsed = Number(draft);
      }
      onEdit(parsed);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (isBinaryType(column.data_type)) return <BinaryField value={value} editable={editable} onEdit={onEdit} />;
  if (/^bool/i.test(column.data_type)) {
    const current = value == null ? "null" : String(value === true || value === 1 || value === "true");
    return (
      <div className="inline-flex rounded-lg border border-border/60 bg-background/40 p-0.5" role="radiogroup" aria-label={column.name}>
        {(["true", "false", "null"] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={current === option}
            disabled={!editable || (option === "null" && !column.nullable)}
            onClick={() => onEdit(option === "null" ? null : option === "true")}
            className={cn(
              "h-7 rounded-md px-3 font-mono text-[12px] transition-colors disabled:opacity-40",
              current === option ? "bg-surface-elevated text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {option === "null" ? "NULL" : option}
          </button>
        ))}
      </div>
    );
  }
  const multiline = draft.includes("\n") || draft.length > 80;
  return (
    <>
      <textarea
        aria-label={column.name}
        value={draft}
        disabled={!editable}
        rows={multiline ? Math.min(10, Math.max(3, draft.split("\n").length)) : 1}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commit();
          }
        }}
        placeholder={value == null ? "NULL" : undefined}
        className={cn(
          "w-full resize-y rounded-md border border-border/70 bg-surface px-2.5 py-1.5 text-[12.5px] leading-relaxed text-foreground placeholder:italic placeholder:text-muted-foreground/50 focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-ring/30 disabled:opacity-60",
          (NUMERIC.test(column.data_type) || /json|uuid|char|text/i.test(column.data_type)) && "font-mono"
        )}
      />
      {error && <p role="alert" className="mt-1 text-[11.5px] text-danger">{error}</p>}
    </>
  );
}

export function RowFormEditor({
  columns,
  rows,
  editable,
  onCellEdit,
  onRowDelete,
  onRowRevert,
  selectedKey,
  onSelect,
}: {
  columns: ColumnInfo[];
  rows: GridRow[];
  editable: boolean;
  onCellEdit: (rowKey: string, columnIndex: number, value: unknown) => void;
  onRowDelete: (key: string) => void;
  onRowRevert: (key: string) => void;
  /** Controlled selection (grid → form jump); falls back to local state. */
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
}) {
  const t = useT();
  const [localKey, setLocalKey] = useState<string>("");
  const currentKey = selectedKey ?? localKey;
  const index = useMemo(() => Math.max(0, rows.findIndex((r) => r.key === currentKey)), [rows, currentKey]);
  const row = rows[index];
  const select = (key: string) => {
    setLocalKey(key);
    onSelect?.(key);
  };

  if (!row) {
    return <div className="flex h-full items-center justify-center p-4 text-[12px] text-muted-foreground">{t("form.empty")}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-surface/30 px-3 py-1.5">
        <button
          type="button"
          aria-label={t("form.prev")}
          title={t("form.prev")}
          disabled={index === 0}
          onClick={() => select(rows[index - 1].key)}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-[12px] tabular-nums text-muted-foreground">
          {t("form.position", { n: index + 1, total: rows.length })}
        </span>
        <button
          type="button"
          aria-label={t("form.next")}
          title={t("form.next")}
          disabled={index >= rows.length - 1}
          onClick={() => select(rows[index + 1].key)}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
        {row.deleted && <span className="rounded bg-danger/15 px-1.5 py-0.5 text-[10.5px] font-medium text-danger">DELETE</span>}
        {row.kind === "insert" && <span className="rounded bg-success/15 px-1.5 py-0.5 text-[10.5px] font-medium text-success">INSERT</span>}
        {row.dirtyCols && row.dirtyCols.size > 0 && row.kind !== "insert" && (
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10.5px] font-medium text-warning">{t("form.modified")}</span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" disabled={!editable} onClick={() => onRowRevert(row.key)}>
          <Undo2 className="h-3.5 w-3.5" />
          {t("form.revert")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!editable}
          onClick={() => onRowDelete(row.key)}
          className={cn(!row.deleted && "text-danger hover:bg-danger/10 hover:text-danger")}
        >
          {row.deleted ? <RotateCcw className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
          {row.deleted ? t("form.restore") : t("form.delete")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <RowFields columns={columns} row={row} editable={editable} onCellEdit={onCellEdit} />
      </div>
    </div>
  );
}

function RowFields({ columns, row, editable, onCellEdit }: {
  columns: ColumnInfo[];
  row: GridRow;
  editable: boolean;
  onCellEdit: (rowKey: string, columnIndex: number, value: unknown) => void;
}) {
  const fieldsRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(fieldsRef);
  // Width is container-local: the form may sit in a narrow split pane even
  // when the window itself is wide. Start stacked until measurement arrives.
  const stacked = width === 0 || width < 560;
  return (
        <div ref={fieldsRef} className="mx-auto max-w-4xl divide-y divide-border/50 px-4 py-2">
          {columns.map((column, i) => {
            const value = row.values[i];
            const isNull = value === null || value === undefined;
            const dirty = row.dirtyCols?.has(i) ?? false;
            return (
              <div key={`${row.key}:${column.name}`} className={cn("grid gap-2 py-3", stacked ? "grid-cols-1" : "grid-cols-[200px_minmax(0,1fr)] gap-4")}>
                <div className="min-w-0 pt-1">
                  <div className="flex items-center gap-1.5">
                    {column.is_primary_key && <KeyRound className="h-3 w-3 shrink-0 text-warning" />}
                    <span className={cn("truncate font-mono text-[12.5px] font-medium", dirty && "text-warning")} title={column.name}>
                      {column.name}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    <span className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-[10px] text-sky-600 dark:text-sky-300">{column.data_type}</span>
                    {!column.nullable && <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">NOT NULL</span>}
                  </div>
                  {column.nullable && !column.is_primary_key && !/^bool/i.test(column.data_type) && (
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={isNull}
                      aria-label={`${column.name} NULL`}
                      disabled={!editable || row.deleted}
                      onClick={() => onCellEdit(row.key, i, isNull ? emptyValueFor(column) : null)}
                      className={cn(
                        "mt-2 h-6 rounded-full border px-2.5 font-mono text-[10.5px] transition-colors disabled:opacity-40",
                        isNull ? "border-brand/60 bg-brand/15 text-brand" : "border-border/70 text-muted-foreground hover:text-foreground"
                      )}
                    >
                      NULL
                    </button>
                  )}
                </div>
                <div className="min-w-0">
                  <FieldEditor column={column} value={value} editable={editable && !row.deleted} onEdit={(next) => onCellEdit(row.key, i, next)} />
                </div>
              </div>
            );
          })}
        </div>
  );
}
