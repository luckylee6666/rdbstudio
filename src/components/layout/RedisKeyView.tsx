import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Copy,
  Loader2,
  RefreshCw,
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

// Quote a Redis key for inclusion in a command, matching the parser in
// src-tauri/src/db/redis_ops.rs::parse_args (double-quotes with \\ and \").
function quoteKey(k: string): string {
  return `"${k.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function fetchCommandFor(type: string, key: string): string {
  const k = quoteKey(key);
  switch (type) {
    case "string":
      return `GET ${k}`;
    case "hash":
      return `HGETALL ${k}`;
    case "list":
      // Pull up to 1000 items; large lists are rare for inspection workflows.
      return `LRANGE ${k} 0 999`;
    case "set":
      return `SMEMBERS ${k}`;
    case "zset":
      return `ZRANGE ${k} 0 999 WITHSCORES`;
    case "stream":
      return `XRANGE ${k} - + COUNT 100`;
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
      const k = quoteKey(redisKey);
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
        {state.kind === "ok" && (
          <RedisValueRender type={redisType ?? ""} result={state.result} />
        )}
      </div>
    </div>
  );
}

function RedisValueRender({
  type,
  result,
}: {
  type: string;
  result: QueryResult;
}) {
  // string: render the single cell as a preformatted block (auto-pretty JSON).
  if (type === "string" || type === "ReJSON-RL") {
    const raw = cellToString(result.rows?.[0]?.[0] ?? "");
    const display = maybePrettyJson(raw);
    return (
      <div className="p-4">
        <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span>{raw.length} chars</span>
          <span>•</span>
          <span>{type === "ReJSON-RL" ? "JSON" : "string"}</span>
        </div>
        <pre className="overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-surface/40 p-3 font-mono text-[12px] text-foreground/90">
          {display}
        </pre>
      </div>
    );
  }

  // Map / list / set / zset / stream — render as a table built from QueryResult.
  return <RedisTable type={type} result={result} />;
}

function RedisTable({ type, result }: { type: string; result: QueryResult }) {
  // Decide column headers based on the value kind. Backend already returns the
  // right shape (1 col for list/set, 2 cols for hash/zset), but we override the
  // generic "field/value" labels with kind-specific ones.
  const columns = useMemo<string[]>(() => {
    const fallback = result.columns.map((c) => c.name);
    switch (type) {
      case "hash":
        return ["field", "value"];
      case "zset":
        return ["member", "score"];
      case "list":
        return ["index", "value"];
      case "set":
        return ["member"];
      case "stream":
        return fallback;
      default:
        return fallback;
    }
  }, [type, result.columns]);

  const rows = result.rows;
  const showIndex = type === "list";
  // zset: backend returns [member, score] pairs already; swap for readability.
  const swap = type === "zset";

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border/60 bg-surface/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        {rows.length} {rows.length === 1 ? "entry" : "entries"}
        {result.elapsed_ms != null && (
          <span className="ml-3">• {result.elapsed_ms}ms</span>
        )}
      </div>
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
              rows.map((row, i) => {
                const displayRow = swap && row.length >= 2 ? [row[0], row[1]] : row;
                return (
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
                    {displayRow.map((v, j) => (
                      <td
                        key={j}
                        className="break-all px-3 py-1 align-top font-mono text-foreground/90"
                      >
                        {cellToString(v)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
