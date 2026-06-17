import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Pencil,
  RefreshCw,
  X,
} from "lucide-react";
import type { WorkspaceTab } from "@/types";
import { api, type QueryResult } from "@/lib/api";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; result: QueryResult; ttlMs: number | null }
  | { kind: "error"; message: string };

// Quote a Redis arg for inclusion in a command, matching parse_args in
// src-tauri/src/db/redis_ops.rs (double-quotes with \\ and \" escapes).
function quoteArg(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// How many entries we pull per collection type. Beyond this the viewer shows
// a "truncated" banner so the user knows the key holds more than is on screen
// (and that editing rows near the cap may address the wrong element).
const RANGE_CAP = 1000; // LRANGE/ZRANGE 0..999
const STREAM_CAP = 100; // XRANGE COUNT

// Cap applied to a given type's fetch, or null when we always read the whole value.
function fetchCapFor(type: string): number | null {
  switch (type) {
    case "list":
    case "zset":
      return RANGE_CAP;
    case "stream":
      return STREAM_CAP;
    default:
      return null;
  }
}

function fetchCommandFor(type: string, key: string): string {
  const k = quoteArg(key);
  switch (type) {
    case "string":
      return `GET ${k}`;
    case "hash":
      return `HGETALL ${k}`;
    case "list":
      return `LRANGE ${k} 0 ${RANGE_CAP - 1}`;
    case "set":
      return `SMEMBERS ${k}`;
    case "zset":
      return `ZRANGE ${k} 0 ${RANGE_CAP - 1} WITHSCORES`;
    case "stream":
      return `XRANGE ${k} - + COUNT ${STREAM_CAP}`;
    case "ReJSON-RL":
      return `JSON.GET ${k}`;
    default:
      return `TYPE ${k}`;
  }
}

function formatTtl(ms: number | null): string {
  if (ms == null) return "—";
  if (ms === -1) return "∞";
  if (ms === -2) return "expired";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Pretty-print a JSON string if parseable, else return the original.
function maybePrettyJson(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return s;
  const first = trimmed[0];
  if (first !== "{" && first !== "[" && first !== '"') return s;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return s;
  }
}

function cellToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function RedisKeyView({ tab }: { tab: WorkspaceTab }) {
  const { connectionId, redisKey, redisType } = tab;
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const inflightRef = useRef<number>(0);

  const load = useCallback(async () => {
    if (!connectionId || !redisKey || !redisType) return;
    const myId = ++inflightRef.current;
    setState({ kind: "loading" });
    try {
      const k = quoteArg(redisKey);
      const cmd = fetchCommandFor(redisType, redisKey);
      // Run value + PTTL in parallel — they are independent reads.
      const [result, pttl] = await Promise.all([
        api.executeQuery(connectionId, cmd),
        api
          .executeQuery(connectionId, `PTTL ${k}`)
          .then((r) => {
            const cell = r.rows?.[0]?.[0];
            return typeof cell === "number" ? cell : null;
          })
          .catch(() => null),
      ]);
      if (inflightRef.current !== myId) return;
      setState({ kind: "ok", result, ttlMs: pttl });
    } catch (e) {
      if (inflightRef.current !== myId) return;
      setState({ kind: "error", message: String(e) });
    }
  }, [connectionId, redisKey, redisType]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCopyKey = () => {
    if (redisKey) void copyText(redisKey);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 bg-surface/30 px-3">
        <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-rose-300">
          {redisType ?? "?"}
        </span>
        <span
          className="truncate font-mono text-[12px] text-foreground"
          title={redisKey}
        >
          {redisKey}
        </span>
        <button
          onClick={onCopyKey}
          title="Copy key name"
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <span className="ml-2 text-[11px] text-muted-foreground">
          TTL{" "}
          <span className="font-mono text-foreground/80">
            {state.kind === "ok" ? formatTtl(state.ttlMs) : "—"}
          </span>
        </span>
        <div className="flex-1" />
        <button
          onClick={() => void load()}
          disabled={state.kind === "loading"}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
        >
          {state.kind === "loading" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Refresh
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {state.kind === "loading" && (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}
        {state.kind === "error" && (
          <div className="m-4 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[12px] text-rose-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-pre-wrap font-mono">{state.message}</span>
          </div>
        )}
        {state.kind === "ok" && connectionId && redisKey && (
          <RedisValueRender
            type={redisType ?? ""}
            result={state.result}
            connectionId={connectionId}
            redisKey={redisKey}
            onReload={load}
          />
        )}
      </div>
    </div>
  );
}

interface EditableProps {
  connectionId: string;
  redisKey: string;
  onReload: () => Promise<void>;
}

function RedisValueRender({
  type,
  result,
  connectionId,
  redisKey,
  onReload,
}: { type: string; result: QueryResult } & EditableProps) {
  if (type === "string" || type === "ReJSON-RL") {
    return (
      <RedisScalarEditor
        type={type}
        result={result}
        connectionId={connectionId}
        redisKey={redisKey}
        onReload={onReload}
      />
    );
  }
  return (
    <RedisTable
      type={type}
      result={result}
      connectionId={connectionId}
      redisKey={redisKey}
      onReload={onReload}
    />
  );
}

function RedisScalarEditor({
  type,
  result,
  connectionId,
  redisKey,
  onReload,
}: { type: string; result: QueryResult } & EditableProps) {
  const raw = cellToString(result.rows?.[0]?.[0] ?? "");
  const isJson = type === "ReJSON-RL";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(raw);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const beginEdit = () => {
    setDraft(raw);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    setEditing(false);
    setError(null);
    setDraft(raw);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const k = quoteArg(redisKey);
      const v = quoteArg(draft);
      const cmd = isJson ? `JSON.SET ${k} $ ${v}` : `SET ${k} ${v}`;
      await api.executeQuery(connectionId, cmd);
      await onReload();
      setEditing(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="p-4">
        <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>editing</span>
          <span>•</span>
          <span>{draft.length} chars</span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          spellCheck={false}
          className="min-h-[200px] w-full resize-y rounded-md border border-border/60 bg-surface/40 p-3 font-mono text-[12px] text-foreground/90 outline-none focus:border-primary"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
        {error && (
          <div className="mt-2 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[12px] text-rose-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-pre-wrap font-mono">{error}</span>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex h-7 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Save
          </button>
          <button
            onClick={cancel}
            disabled={saving}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 px-3 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
          <span className="ml-2 text-[11px] text-muted-foreground">
            ⌘/Ctrl+Enter to save · Esc to cancel
          </span>
        </div>
      </div>
    );
  }

  const display = maybePrettyJson(raw);
  return (
    <div className="p-4">
      <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>{raw.length} chars</span>
        <span>•</span>
        <span>{isJson ? "JSON" : "string"}</span>
        <div className="flex-1" />
        <button
          onClick={beginEdit}
          className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
      </div>
      <pre
        onDoubleClick={beginEdit}
        title="Double-click to edit"
        className="cursor-text overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-surface/40 p-3 font-mono text-[12px] text-foreground/90"
      >
        {display}
      </pre>
    </div>
  );
}

function CellEditor({
  initial,
  onCancel,
  onCommit,
}: {
  initial: string;
  onCancel: () => void;
  onCommit: (next: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter triggers commit() then blurs the textarea; without this guard, the
  // follow-up onBlur fires a second commit() and double-issues the IPC.
  const committedRef = useRef(false);

  const commit = async () => {
    if (committedRef.current) return;
    if (draft === initial) {
      committedRef.current = true;
      onCancel();
      return;
    }
    committedRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onCommit(draft);
    } catch (e) {
      setError(String(e));
      setSaving(false);
      committedRef.current = false;
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoFocus
        spellCheck={false}
        rows={Math.min(6, Math.max(1, draft.split("\n").length))}
        disabled={saving}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void commit();
          }
        }}
        onBlur={() => {
          if (!saving) void commit();
        }}
        className="w-full resize-y rounded border border-primary/60 bg-background px-1.5 py-1 font-mono text-[12px] text-foreground outline-none focus:border-primary"
      />
      {error && (
        <div className="text-[11px] text-rose-300">{error}</div>
      )}
    </div>
  );
}

interface CellLocation {
  row: number;
  col: number;
}

function RedisTable({
  type,
  result,
  connectionId,
  redisKey,
  onReload,
}: { type: string; result: QueryResult } & EditableProps) {
  // Column headers per kind. zset backend returns [member, score] already; do
  // not swap — keep storage order so saves can address the right column.
  const columns = useMemo<string[]>(() => {
    const fallback = result.columns.map((c) => c.name);
    switch (type) {
      case "hash":
        return ["field", "value"];
      case "zset":
        return ["member", "score"];
      case "set":
        return ["member"];
      default:
        return fallback;
    }
  }, [type, result.columns]);

  const rows = result.rows;
  const showIndex = type === "list";
  const [editing, setEditing] = useState<CellLocation | null>(null);

  // A full page likely means the collection holds more than we fetched.
  const cap = fetchCapFor(type);
  const maybeTruncated = cap != null && rows.length >= cap;

  // Which (type, columnIndex) cells are editable. stream is read-only.
  const isEditable = (col: number): boolean => {
    if (type === "stream") return false;
    if (type === "list") return col === 0; // single data column = value
    if (type === "set") return col === 0;
    return true; // hash: both, zset: both
  };

  const saveCell = async (
    rowIdx: number,
    colIdx: number,
    next: string
  ): Promise<void> => {
    const row = rows[rowIdx];
    if (!row) return;
    const k = quoteArg(redisKey);
    const commands: string[] = [];
    switch (type) {
      case "hash": {
        const oldField = cellToString(row[0]);
        const oldValue = cellToString(row[1]);
        if (colIdx === 0) {
          // Rename field: HSET k newField oldValue, then HDEL k oldField.
          if (next === oldField) break;
          commands.push(`HSET ${k} ${quoteArg(next)} ${quoteArg(oldValue)}`);
          commands.push(`HDEL ${k} ${quoteArg(oldField)}`);
        } else {
          commands.push(`HSET ${k} ${quoteArg(oldField)} ${quoteArg(next)}`);
        }
        break;
      }
      case "list": {
        // Use the table's own row index — LRANGE returns elements 0..N-1.
        commands.push(`LSET ${k} ${rowIdx} ${quoteArg(next)}`);
        break;
      }
      case "set": {
        const oldMember = cellToString(row[0]);
        if (next === oldMember) break;
        commands.push(`SREM ${k} ${quoteArg(oldMember)}`);
        commands.push(`SADD ${k} ${quoteArg(next)}`);
        break;
      }
      case "zset": {
        const oldMember = cellToString(row[0]);
        const oldScore = cellToString(row[1]);
        if (colIdx === 0) {
          if (next === oldMember) break;
          commands.push(`ZREM ${k} ${quoteArg(oldMember)}`);
          commands.push(`ZADD ${k} ${oldScore} ${quoteArg(next)}`);
        } else {
          // Validate numeric score before sending.
          if (!/^-?\d+(\.\d+)?$/.test(next.trim())) {
            throw new Error("score must be a number");
          }
          commands.push(`ZADD ${k} ${next.trim()} ${quoteArg(oldMember)}`);
        }
        break;
      }
    }
    for (const cmd of commands) {
      await api.executeQuery(connectionId, cmd);
    }
    setEditing(null);
    await onReload();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/60 bg-surface/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        {rows.length} {rows.length === 1 ? "entry" : "entries"}
        {result.elapsed_ms != null && (
          <span className="ml-3">• {result.elapsed_ms}ms</span>
        )}
        {type !== "stream" && (
          <span className="ml-3 text-muted-foreground/70">
            · double-click a cell to edit
          </span>
        )}
      </div>
      {maybeTruncated && (
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Showing the first {cap} entries — this key holds more. Editing rows
            here is limited to what's loaded.
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
            <tr>
              {showIndex && (
                <th className="border-b border-border/60 px-3 py-1.5 text-left font-medium text-muted-foreground">
                  #
                </th>
              )}
              {columns.map((c) => (
                <th
                  key={c}
                  className="border-b border-border/60 px-3 py-1.5 text-left font-medium text-muted-foreground"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  colSpan={(showIndex ? 1 : 0) + columns.length}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  (empty)
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr
                  key={i}
                  className={cn(
                    "border-b border-border/40 hover:bg-accent/30",
                    i % 2 === 1 && "bg-surface/20"
                  )}
                >
                  {showIndex && (
                    <td className="px-3 py-1 font-mono text-muted-foreground">
                      {i}
                    </td>
                  )}
                  {row.map((v, j) => {
                    const current = cellToString(v);
                    const editable = isEditable(j);
                    const isEditing =
                      editing?.row === i && editing?.col === j;
                    return (
                      <td
                        key={j}
                        onDoubleClick={() => {
                          if (editable) setEditing({ row: i, col: j });
                        }}
                        title={editable ? "Double-click to edit" : undefined}
                        className={cn(
                          "break-all px-3 py-1 align-top font-mono text-foreground/90",
                          editable && !isEditing && "cursor-text"
                        )}
                      >
                        {isEditing ? (
                          <CellEditor
                            initial={current}
                            onCancel={() => setEditing(null)}
                            onCommit={(next) => saveCell(i, j, next)}
                          />
                        ) : (
                          current
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
