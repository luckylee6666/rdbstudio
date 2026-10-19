import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Activity,
  AlertTriangle,
  Check,
  Copy,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { WorkspaceTab } from "@/types";
import { api, type QueryResult } from "@/lib/api";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { useT } from "@/store/i18n";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { toast } from "@/store/toasts";
import { PromptDialog } from "@/components/ui/PromptDialog";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { redisTools, type RedisPage, type RedisHashEntry, type RedisStreamEntry } from "@/lib/redisTools";
import { RedisToolsView } from "./RedisToolsView";
import { RedisStreamTools } from "./RedisStreamTools";
import { useRedisToolsT } from "./redisToolsI18n";

/** Viewer reads are UI plumbing, not user queries: keep them out of history. */
const BACKGROUND = { recordHistory: false } as const;

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ok";
      result: QueryResult;
      ttlMs: number | null;
      page?: { cursor: string; done: boolean; truncated: boolean; type: "hash" | "set" | "stream" };
    }
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

// Capped fetches ask for cap+1 items: getting the extra row proves the key
// holds more than the cap (a result of exactly `cap` rows is complete, not
// truncated). The table slices back down to `cap` before rendering.
function fetchCommandFor(type: string, key: string): string {
  const k = quoteArg(key);
  switch (type) {
    case "string":
      return `GET ${k}`;
    case "hash":
      return `HGETALL ${k}`;
    case "list":
      return `LRANGE ${k} 0 ${RANGE_CAP}`;
    case "set":
      return `SMEMBERS ${k}`;
    case "zset":
      return `ZRANGE ${k} 0 ${RANGE_CAP} WITHSCORES`;
    case "stream":
      return `XRANGE ${k} - + COUNT ${STREAM_CAP + 1}`;
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

function resultPage<T>(columns: QueryResult["columns"], rows: unknown[][], page: RedisPage<T>): QueryResult {
  const seen = new Set<string>();
  const unique = rows.filter((row) => {
    const key = JSON.stringify(row[0] ?? null);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { columns, rows: unique, rows_affected: null, elapsed_ms: 0, truncated: page.truncated };
}

function hashPageResult(page: RedisPage<RedisHashEntry>): QueryResult {
  return resultPage(
    [{ name: "field", data_type: "redis" }, { name: "value", data_type: "redis" }],
    page.items.map((item) => [item.field, item.value]),
    page
  );
}

function setPageResult(page: RedisPage<string>): QueryResult {
  return resultPage([{ name: "member", data_type: "redis" }], page.items.map((item) => [item]), page);
}

function streamPageResult(page: RedisPage<RedisStreamEntry>): QueryResult {
  return resultPage(
    [{ name: "id", data_type: "redis" }, { name: "fields", data_type: "json" }],
    page.items.map((item) => [item.id, item.fields]),
    page
  );
}

export function RedisKeyView({ tab }: { tab: WorkspaceTab }) {
  const { connectionId, redisKey, redisType } = tab;
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [ttlOpen, setTtlOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);
  const inflightRef = useRef<number>(0);
  const t = useT();
  const toolText = useRedisToolsT();
  const connectionReadOnly = useConnections((s) => s.list.find((item) => item.id === connectionId)?.read_only ?? false);
  const refreshBranch = useConnections((s) => s.refreshBranch);
  const closeTab = useWorkspace((s) => s.closeTab);
  const openTab = useWorkspace((s) => s.openTab);

  const load = useCallback(async () => {
    if (!connectionId || redisKey == null || !redisType) return;
    const myId = ++inflightRef.current;
    setState({ kind: "loading" });
    try {
      const k = quoteArg(redisKey);
      // Run value + PTTL in parallel — they are independent reads.
      const pagedType: "hash" | "set" | "stream" | null = redisType === "hash" || redisType === "set" || redisType === "stream" ? redisType : null;
      const [rawResult, pttl] = await Promise.all([
        pagedType === "hash"
          ? Promise.resolve(redisTools.hscan(connectionId, redisKey)).then((page) => ({ page, result: hashPageResult(page) }))
          : pagedType === "set"
            ? Promise.resolve(redisTools.sscan(connectionId, redisKey)).then((page) => ({ page, result: setPageResult(page) }))
            : pagedType === "stream"
              ? Promise.resolve(redisTools.xrange(connectionId, redisKey)).then((page) => ({ page, result: streamPageResult(page) }))
              : api.executeQuery(connectionId, fetchCommandFor(redisType, redisKey), undefined, undefined, BACKGROUND).then((result) => ({ result, page: null })),
          Promise.resolve(api.executeQuery(connectionId, `PTTL ${k}`, undefined, undefined, BACKGROUND))
          .then((r) => {
            const cell = r.rows?.[0]?.[0];
            return typeof cell === "number" ? cell : null;
          })
          .catch(() => null),
      ]);
      if (inflightRef.current !== myId) return;
      const page = rawResult.page && pagedType
        ? { cursor: rawResult.page.cursor, done: rawResult.page.done, truncated: rawResult.page.truncated, type: pagedType }
        : undefined;
      setState({ kind: "ok", result: rawResult.result, ttlMs: pttl, page });
    } catch (e) {
      if (inflightRef.current !== myId) return;
      setState({ kind: "error", message: String(e) });
    }
  }, [connectionId, redisKey, redisType]);

  const loadMore = useCallback(async () => {
    if (!connectionId || redisKey == null || state.kind !== "ok" || !state.page || state.page.done || moreLoading) return;
    setMoreLoading(true);
    try {
      const page = state.page.type === "hash"
        ? await redisTools.hscan(connectionId, redisKey, state.page.cursor)
        : state.page.type === "set"
          ? await redisTools.sscan(connectionId, redisKey, state.page.cursor)
          : await redisTools.xrange(connectionId, redisKey, state.page.cursor);
      const next = state.page.type === "hash" ? hashPageResult(page as RedisPage<RedisHashEntry>)
        : state.page.type === "set" ? setPageResult(page as RedisPage<string>)
          : streamPageResult(page as RedisPage<RedisStreamEntry>);
      setState((current) => current.kind === "ok" && current.page ? {
        ...current,
        result: {
          ...next,
          rows: [...current.result.rows, ...next.rows.filter((row) => !current.result.rows.some((existing) => JSON.stringify(existing[0] ?? null) === JSON.stringify(row[0] ?? null)))],
          truncated: current.result.truncated || next.truncated,
        },
        page: { ...current.page, cursor: page.cursor, done: page.done, truncated: current.page.truncated || page.truncated },
      } : current);
    } catch (error) {
      toast.error(toolText("loadMoreFailed"), String(error));
    } finally {
      setMoreLoading(false);
    }
  }, [connectionId, redisKey, state, moreLoading, toolText]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCopyKey = () => {
    if (redisKey != null) void copyText(redisKey);
  };

  // Seconds shown in the TTL prompt — empty when the key is missing, persistent
  // or expired, so opening the dialog just means "type a number to expire".
  const ttlSeconds =
    state.kind === "ok" && state.ttlMs != null && state.ttlMs > 0
      ? String(Math.ceil(state.ttlMs / 1000))
      : "";

  const onSetTtl = async (raw: string) => {
    if (!connectionId || redisKey == null) return;
    const trimmed = raw.trim();
    let ttl: number | null = null;
    if (trimmed !== "") {
      if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
        throw new Error(t("redis.ttl.invalid"));
      }
      ttl = Number(trimmed);
    }
    const existed = await api.redisSetTtl(connectionId, redisKey, ttl);
    if (!existed) throw new Error(t("redis.ttl.missing"));
    toast.success(ttl == null ? t("redis.ttl.done_persist") : t("redis.ttl.done"));
    await refreshBranch(connectionId);
    await load();
  };

  const onRenameKey = async (next: string) => {
    if (!connectionId || redisKey == null) return;
    if (!next) throw new Error(t("redis.create.err.key_required"));
    if (next === redisKey) throw new Error(t("redis.rename_key.unchanged"));
    await api.redisRenameKey(connectionId, redisKey, next);
    toast.success(t("redis.rename_key.done", { name: next }));
    // The tab id embeds the key name; move the viewer to a tab for the new
    // name instead of leaving a stale title behind.
    if (redisType) {
      closeTab(tab.id);
      openTab({
        id: `redis:${connectionId}:${next}`,
        kind: "redis-key",
        title: next,
        subtitle: redisType,
        connectionId,
        redisKey: next,
        redisType,
      });
    }
    await refreshBranch(connectionId);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 bg-surface/30 px-3">
        <span className="rounded bg-rose-500/15 px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-rose-700 dark:text-rose-300">
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
          title={t("redis.copy_key")}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setToolsOpen((open) => !open)}
          title={toolText("tools")}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        ><Activity className="h-3.5 w-3.5" /></button>
        <button
          onClick={() => setRenameOpen(true)}
          disabled={connectionReadOnly}
          title={t("redis.rename_key")}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setTtlOpen(true)}
          disabled={connectionReadOnly}
          title={t("redis.ttl.edit")}
          className="ml-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          TTL{" "}
          <span className="font-mono text-foreground/80">
            {state.kind === "ok" ? formatTtl(state.ttlMs) : "—"}
          </span>
          <Pencil className="h-3 w-3" />
        </button>
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
          {t("common.refresh")}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {toolsOpen && connectionId ? <RedisToolsView connectionId={connectionId} onBack={() => setToolsOpen(false)} /> : null}
        {!toolsOpen && <>
        {state.kind === "loading" && (
          <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {t("common.loading")}
          </div>
        )}
        {state.kind === "error" && (
          <div className="m-4 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-pre-wrap font-mono">{state.message}</span>
          </div>
        )}
        {state.kind === "ok" && connectionId && redisKey != null && (
          <RedisValueRender
            type={redisType ?? ""}
            result={state.result}
            connectionId={connectionId}
            redisKey={redisKey}
            onReload={load}
            page={state.page}
            moreLoading={moreLoading}
            onLoadMore={() => void loadMore()}
          />
        )}
        </>}
      </div>

      <PromptDialog
        open={renameOpen}
        title={t("redis.rename_key")}
        label={t("redis.rename_key.prompt")}
        initialValue={redisKey ?? ""}
        submitLabel={t("common.save")}
        cancelLabel={t("common.cancel")}
        onSubmit={(v) => onRenameKey(v)}
        onClose={() => setRenameOpen(false)}
      />
      <PromptDialog
        open={ttlOpen}
        title={t("redis.ttl.edit")}
        label={t("redis.ttl.prompt")}
        initialValue={ttlSeconds}
        placeholder={t("redis.ttl.persist")}
        submitLabel={t("common.save")}
        cancelLabel={t("common.cancel")}
        onSubmit={(v) => onSetTtl(v)}
        onClose={() => setTtlOpen(false)}
      />
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
  page,
  moreLoading,
  onLoadMore,
}: { type: string; result: QueryResult; page?: { cursor: string; done: boolean; truncated: boolean; type: "hash" | "set" | "stream" }; moreLoading: boolean; onLoadMore: () => void } & EditableProps) {
  const readOnly = useConnections((s) => s.list.find((item) => item.id === connectionId)?.read_only ?? false);
  if (type === "string" || type === "ReJSON-RL") {
    return (
      <RedisScalarEditor
        type={type}
        result={result}
        connectionId={connectionId}
        redisKey={redisKey}
        readOnly={readOnly}
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
      page={page}
      moreLoading={moreLoading}
      onLoadMore={onLoadMore}
    />
  );
}

function RedisScalarEditor({
  type,
  result,
  connectionId,
  redisKey,
  readOnly,
  onReload,
}: { type: string; result: QueryResult; readOnly: boolean } & EditableProps) {
  const raw = cellToString(result.rows?.[0]?.[0] ?? "");
  const isJson = type === "ReJSON-RL";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(raw);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const t = useT();
  const binary = result.columns.some((column) => column.data_type === "redis-binary-base64");
  const incomplete = result.truncated || binary;

  const beginEdit = () => {
    if (incomplete) return;
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
      // Redis SET clears an existing expiry by default. KEEPTTL preserves it
      // atomically and does not extend it based on a stale PTTL read.
      if (incomplete) throw new Error(t("redis.scalar_truncated"));
      const cmd = isJson ? `JSON.SET ${k} $ ${v}` : `SET ${k} ${v} KEEPTTL`;
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
          <span>{t("redis.editing")}</span>
          <span>•</span>
          <span>{t("redis.chars", { n: draft.length })}</span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          spellCheck={false}
          className="min-h-[200px] w-full resize-y rounded-md border border-border/60 bg-surface/40 p-3 font-mono text-[12px] text-foreground/90 outline-none focus:border-brand/60"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
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
          <div className="mt-2 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[12px] text-rose-700 dark:text-rose-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="whitespace-pre-wrap font-mono">{error}</span>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex h-7 items-center gap-1.5 rounded-md bg-brand px-3 text-[12px] font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {t("common.save")}
          </button>
          <button
            onClick={cancel}
            disabled={saving}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 px-3 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-60"
          >
            <X className="h-3.5 w-3.5" />
            {t("common.cancel")}
          </button>
          <span className="ml-2 text-[11px] text-muted-foreground">
            {t("redis.save_hint")}
          </span>
        </div>
      </div>
    );
  }

  const display = maybePrettyJson(raw);
  return (
    <div className="p-4">
      {incomplete && (
        <div role="status" className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
          {binary ? t("redis.binary_readonly") : t("redis.scalar_truncated")}
        </div>
      )}
      <div className="mb-2 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>{t("redis.chars", { n: raw.length })}</span>
        <span>•</span>
        <span>{isJson ? "JSON" : "string"}</span>
        <div className="flex-1" />
        <button
          onClick={beginEdit}
          disabled={incomplete || readOnly}
          title={incomplete ? t(binary ? "redis.binary_readonly" : "redis.scalar_truncated") : undefined}
          className="flex h-6 items-center gap-1 rounded px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
          {t("common.edit")}
        </button>
      </div>
      <pre
        onDoubleClick={beginEdit}
        title={t("redis.dblclick_edit")}
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
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  // Scrolling a virtualized row out of view unmounts the editor without a
  // blur; flush the draft so the edit isn't silently lost.
  useEffect(
    () => () => {
      if (!committedRef.current && draftRef.current !== initial) {
        committedRef.current = true;
        void onCommitRef.current(draftRef.current);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

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
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            committedRef.current = true;
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void commit();
          }
        }}
        onBlur={() => {
          if (!saving) void commit();
        }}
        className="w-full resize-y rounded border border-brand/60 bg-background px-1.5 py-1 font-mono text-[12px] text-foreground outline-none focus:border-brand/60"
      />
      {error && (
        <div className="text-[11px] text-rose-700 dark:text-rose-300">{error}</div>
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
  page,
  moreLoading,
  onLoadMore,
}: { type: string; result: QueryResult; page?: { cursor: string; done: boolean; truncated: boolean; type: "hash" | "set" | "stream" }; moreLoading: boolean; onLoadMore: () => void } & EditableProps) {
  const t = useT();
  const toolText = useRedisToolsT();
  const readOnly = useConnections((s) => s.list.find((item) => item.id === connectionId)?.read_only ?? false);
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

  // Fetches ask for cap+1: the extra row is proof of truncation, never shown.
  // Exactly `cap` rows = the whole collection, no false banner.
  const cap = page ? null : fetchCapFor(type);
  const maybeTruncated = cap != null && result.rows.length > cap;
  const rows = useMemo(
    () => (maybeTruncated && cap != null ? result.rows.slice(0, cap) : result.rows),
    [result.rows, maybeTruncated, cap]
  );
  const showIndex = type === "list";
  const [editing, setEditing] = useState<CellLocation | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ member: string; index: number } | null>(null);
  const [adding, setAdding] = useState(false);
  const [addField, setAddField] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addScore, setAddScore] = useState("0");
  const [savingAdd, setSavingAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const canDeleteMember = !readOnly && (type === "hash" || type === "list" || type === "set" || type === "zset" || type === "stream");
  const canAddMember = !readOnly && (type === "hash" || type === "list" || type === "set" || type === "zset");

  const deleteMember = async (member: string, index: number) => {
    try {
      const deleted = type === "stream"
        ? await redisTools.xdel(connectionId, redisKey, [member])
        : type === "list"
          ? (await redisTools.listDeleteCas(connectionId, redisKey, index, member), 1)
          : await api.redisDeleteMember(connectionId, redisKey, type as "hash" | "set" | "zset", member);
      if (deleted > 0) toast.success(t("redis.member.delete_done"));
      setEditing(null);
      await onReload();
    } catch (e) {
      toast.error(t("redis.member.delete_failed"), String(e));
    }
  };

  const addMember = async () => {
    if (readOnly || !canAddMember) return;
    let command: string;
    const k = quoteArg(redisKey);
    const value = quoteArg(addValue);
    if (type === "hash") {
      command = `HSETNX ${k} ${quoteArg(addField)} ${value}`;
    } else if (type === "set") {
      command = `SADD ${k} ${value}`;
    } else if (type === "list") {
      command = `RPUSH ${k} ${value}`;
    } else {
      const score = addScore.trim();
      if (!/^-?\d+(\.\d+)?$/.test(score)) {
        setAddError(t("redis.member.add_score_invalid"));
        return;
      }
      command = `ZADD ${k} NX ${score} ${value}`;
    }
    setSavingAdd(true);
    setAddError(null);
    try {
      const result = await api.executeQuery(connectionId, command);
      if (type !== "list" && Number(result.rows?.[0]?.[0]) === 0) {
        throw new Error(t("redis.member.add_exists"));
      }
      toast.success(t("redis.member.add_done"));
      setAdding(false);
      setAddField("");
      setAddValue("");
      setAddScore("0");
      await onReload();
    } catch (error) {
      setAddError(String(error));
    } finally {
      setSavingAdd(false);
    }
  };

  // Which (type, columnIndex) cells are editable. stream is read-only.
  const isEditable = (col: number): boolean => {
    if (readOnly) return false;
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
    // Renames go through a dedicated backend command running a guarded Lua
    // script — atomic, and it refuses to clobber an existing target (the old
    // delete-then-add pair could silently merge or drop values on races).
    let rename: { kind: "hash" | "set" | "zset"; from: string } | null = null;
    switch (type) {
      case "hash": {
        const oldField = cellToString(row[0]);
        if (colIdx === 0) {
          if (next === oldField) break;
          rename = { kind: "hash", from: oldField };
        } else {
          commands.push(`HSET ${k} ${quoteArg(oldField)} ${quoteArg(next)}`);
        }
        break;
      }
      case "list": {
        // Compare the old slot atomically so concurrent list edits/length
        // changes never redirect this write to a different value.
        await redisTools.listSetCas(connectionId, redisKey, rowIdx, cellToString(row[0]), next);
        break;
      }
      case "set": {
        const oldMember = cellToString(row[0]);
        if (next === oldMember) break;
        rename = { kind: "set", from: oldMember };
        break;
      }
      case "zset": {
        const oldMember = cellToString(row[0]);
        if (colIdx === 0) {
          if (next === oldMember) break;
          rename = { kind: "zset", from: oldMember };
        } else {
          // Validate numeric score before sending.
          if (!/^-?\d+(\.\d+)?$/.test(next.trim())) {
            throw new Error(t("redis.score_number"));
          }
          commands.push(`ZADD ${k} ${next.trim()} ${quoteArg(oldMember)}`);
        }
        break;
      }
    }
    if (rename) {
      await api.redisRenameMember(
        connectionId,
        redisKey,
        rename.kind,
        rename.from,
        next
      );
    } else {
      for (const cmd of commands) {
        await api.executeQuery(connectionId, cmd);
      }
    }
    setEditing(null);
    await onReload();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center border-b border-border/60 bg-surface/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        {t("redis.entries", { n: rows.length })}
        {result.elapsed_ms != null && (
          <span className="ml-3">• {result.elapsed_ms}ms</span>
        )}
        {type !== "stream" && (
          <span className="ml-3 text-muted-foreground/70">
            {t("redis.cell_hint")}
          </span>
        )}
        <div className="flex-1" />
        {canAddMember && (
          <button
            onClick={() => { setAdding((open) => !open); setAddError(null); }}
            disabled={savingAdd}
            className="flex items-center gap-1 rounded px-2 py-1 text-brand hover:bg-accent disabled:opacity-50"
          >
            <Plus className="h-3 w-3" />
            {t("redis.member.add")}
          </button>
        )}
      </div>
      {adding && canAddMember && (
        <div className="flex flex-wrap items-end gap-2 border-b border-border/60 bg-surface/20 px-3 py-2">
          {type === "hash" && (
            <label className="flex min-w-32 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
              {t("redis.member.add_field")}
              <input aria-label={t("redis.member.add_field")} value={addField} onChange={(event) => setAddField(event.target.value)} disabled={savingAdd} className="h-7 rounded border border-border/60 bg-background px-2 font-mono text-xs text-foreground" />
            </label>
          )}
          {type === "zset" && (
            <label className="flex w-28 flex-col gap-1 text-[11px] text-muted-foreground">
              {t("redis.member.add_score")}
              <input aria-label={t("redis.member.add_score")} value={addScore} onChange={(event) => setAddScore(event.target.value)} disabled={savingAdd} className="h-7 rounded border border-border/60 bg-background px-2 font-mono text-xs text-foreground" />
            </label>
          )}
          <label className="flex min-w-32 flex-1 flex-col gap-1 text-[11px] text-muted-foreground">
            {type === "hash" ? t("redis.member.add_value") : type === "list" ? t("redis.member.add_value") : t("redis.member.add_member")}
            <input aria-label={type === "hash" ? t("redis.member.add_value") : type === "list" ? t("redis.member.add_value") : t("redis.member.add_member")} value={addValue} onChange={(event) => setAddValue(event.target.value)} disabled={savingAdd} className="h-7 rounded border border-border/60 bg-background px-2 font-mono text-xs text-foreground" />
          </label>
          <button onClick={() => void addMember()} disabled={savingAdd} className="flex h-7 items-center gap-1 rounded bg-brand px-2 text-xs text-brand-foreground disabled:opacity-50">
            {savingAdd ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {t("redis.member.add_submit")}
          </button>
          <button onClick={() => { setAdding(false); setAddError(null); }} disabled={savingAdd} className="h-7 rounded px-2 text-xs text-muted-foreground hover:bg-accent disabled:opacity-50">
            {t("redis.member.add_cancel")}
          </button>
          {addError && <div role="alert" className="w-full text-xs text-danger">{addError}</div>}
        </div>
      )}
      {result.truncated && !(maybeTruncated && cap != null) && (
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("redis.reply_truncated")}</span>
        </div>
      )}
      {maybeTruncated && cap != null && (
        <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("redis.truncated", { n: cap })}</span>
        </div>
      )}
      {type === "stream" && <RedisStreamTools connectionId={connectionId} redisKey={redisKey} readOnly={readOnly} onChanged={onReload} />}
      <div className="flex shrink-0 items-stretch border-b border-border/60 bg-surface/95 text-[12px]">
        {showIndex && (
          <div className="w-14 shrink-0 px-3 py-1.5 font-medium text-muted-foreground">
            #
          </div>
        )}
        {columns.map((c) => (
          <div
            key={c}
            className="min-w-0 flex-1 px-3 py-1.5 font-medium text-muted-foreground"
          >
            {c}
          </div>
        ))}
        {canDeleteMember && <div className="w-8 shrink-0" />}
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
          {t("redis.empty")}
        </div>
      ) : (
        <VirtualRows
          rows={rows}
          showIndex={showIndex}
          isEditable={isEditable}
          editing={editing}
          setEditing={setEditing}
          saveCell={saveCell}
          onDeleteMember={canDeleteMember ? (member, index) => setDeleteTarget({ member, index }) : undefined}
        />
      )}
      {page && !page.done && (
        <button onClick={onLoadMore} disabled={moreLoading} className="border-t border-border/60 px-3 py-2 text-xs text-brand hover:bg-accent/40 disabled:opacity-50">
          {moreLoading ? t("common.loading") : toolText("loadMore")}
        </button>
      )}
      <ConfirmDialog
        open={deleteTarget != null}
        title={t("redis.member.delete")}
        message={t("redis.member.delete_confirm", {
          member: deleteTarget?.member ?? "",
        })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => {
          if (deleteTarget != null) void deleteMember(deleteTarget.member, deleteTarget.index);
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

/// Virtualized body — a hash/list at the 1000-row cap would otherwise render
/// every row into the DOM. Rows self-measure (values wrap, editors grow).
function VirtualRows({
  rows,
  showIndex,
  isEditable,
  editing,
  setEditing,
  saveCell,
  onDeleteMember,
}: {
  rows: unknown[][];
  showIndex: boolean;
  isEditable: (col: number) => boolean;
  editing: CellLocation | null;
  setEditing: (c: CellLocation | null) => void;
  saveCell: (row: number, col: number, next: string) => Promise<void>;
  onDeleteMember?: (member: string, index: number) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 29,
    overscan: 12,
  });

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualizer.getVirtualItems().map((vr) => {
          const row = rows[vr.index];
          return (
            <div
              key={vr.key}
              data-index={vr.index}
              ref={virtualizer.measureElement}
              className={cn(
                "group/row absolute left-0 flex w-full items-stretch border-b border-border/40 text-[12px] hover:bg-accent/30",
                vr.index % 2 === 1 && "bg-surface/20"
              )}
              style={{ transform: `translateY(${vr.start}px)` }}
            >
              {showIndex && (
                <div className="w-14 shrink-0 px-3 py-1 font-mono text-muted-foreground">
                  {vr.index}
                </div>
              )}
              {row.map((v, j) => {
                const current = cellToString(v);
                const displayOnly = row.some((value) => {
                  const text = cellToString(value);
                  return text.startsWith("base64:") || text.startsWith("[value omitted:");
                });
                const editable = isEditable(j) && !displayOnly;
                const isEditing =
                  editing?.row === vr.index && editing?.col === j;
                return (
                  <div
                    key={j}
                    onDoubleClick={() => {
                      if (editable) setEditing({ row: vr.index, col: j });
                    }}
                    title={editable ? t("redis.dblclick_edit") : undefined}
                    className={cn(
                      "min-w-0 flex-1 break-all px-3 py-1 align-top font-mono text-foreground/90",
                      editable && !isEditing && "cursor-text"
                    )}
                  >
                    {isEditing ? (
                      <CellEditor
                        initial={current}
                        onCancel={() => setEditing(null)}
                        onCommit={(next) => saveCell(vr.index, j, next)}
                      />
                    ) : (
                      current
                    )}
                  </div>
                );
              })}
              {onDeleteMember && (
                <div className="flex w-8 shrink-0 items-center justify-center">
                  <button
                    disabled={cellToString(row[0]).startsWith("base64:") || cellToString(row[0]).startsWith("[value omitted:")}
                    onClick={() => onDeleteMember(cellToString(row[0]), vr.index)}
                    title={t("redis.member.delete")}
                    aria-label={t("redis.member.delete")}
                    className="grid h-5 w-5 place-items-center rounded text-muted-foreground opacity-0 hover:bg-danger/10 hover:text-danger group-hover/row:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
