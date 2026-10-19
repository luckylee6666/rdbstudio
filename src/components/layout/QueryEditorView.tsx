import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  BookmarkPlus,
  Check,
  CheckCircle2,
  ChevronDown,
  Columns2,
  Database,
  Download,
  Ellipsis,
  FolderOpen,
  Save,
  ListStart,
  ListTree,
  Loader2,
  Pin,
  Play,
  RotateCcw,
  Square,
  Undo2,
  Unplug,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import { format as formatSql } from "sql-formatter";
import type { WorkspaceTab } from "@/types";
import { api, type QueryResult } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { CodeMirrorEditor } from "@/components/editor/CodeMirror";
import { DataGrid, type GridColumn } from "@/components/grid/DataGrid";
import { ContextMenu, type MenuEntry } from "@/components/ui/ContextMenu";
import { saveTextFile, toCSV } from "@/lib/csv";
import { toInsertSql, toJSONRows } from "@/lib/rowcopy";
import {
  explainWrap,
  isReadOnlyStatement,
  splitRedisCommands,
  splitStatements,
  stripLeadingComments,
} from "@/lib/sql";
import { getSchemaColumns, setSchemaColumns } from "@/lib/schemaCache";
import { cn } from "@/lib/cn";
import { useT } from "@/store/i18n";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { connColorValue } from "@/lib/connColors";
import { modKey } from "@/lib/platform";
import { useElementWidth } from "@/lib/useElementWidth";
import { openSqlFile } from "@/lib/sqlFile";
import { toast } from "@/store/toasts";

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "ok";
      result: QueryResult;
      results?: QueryResult[];
      // For multi-statement scripts: how many statements ran in total, and a summary.
      statements?: { count: number; affected_total: number };
    }
  | { kind: "error"; message: string; failedAt?: number };

const INITIAL = `SELECT 1 AS hello, 'world' AS greet;`;

// SQL primed via sessionStorage when opening a "DDL" or history tab — see
// ConnectionTree.showDdlTab and HistoryPanel.onOpen.
function primedFor(tabId: string): string | null {
  try {
    const k = `rdb:sql:${tabId}`;
    const v = sessionStorage.getItem(k);
    if (v != null) sessionStorage.removeItem(k);
    return v;
  } catch {
    return null;
  }
}

// Buffer persisted across restarts (the workspace's tab list survives via
// zustand persist; the SQL text lives here). Cleared by workspace.closeTab.
function savedBuffer(tabId: string): string | null {
  try {
    return localStorage.getItem(`rdb:buf:${tabId}`);
  } catch {
    return null;
  }
}

function persistBuffer(tabId: string, sql: string) {
  try {
    if (sql.trim() && sql !== INITIAL) {
      localStorage.setItem(`rdb:buf:${tabId}`, sql);
    } else {
      localStorage.removeItem(`rdb:buf:${tabId}`);
    }
  } catch {
    /* storage unavailable — buffer stays volatile */
  }
}

export function QueryEditorView({ tab }: { tab: WorkspaceTab }) {
  const [sql, setSql] = useState(
    () => primedFor(tab.id) ?? savedBuffer(tab.id) ?? INITIAL
  );
  const latestSqlRef = useRef(sql);
  latestSqlRef.current = sql;

  // Persist the buffer (debounced) so restarts restore what the user typed.
  useEffect(() => {
    const h = setTimeout(() => persistBuffer(tab.id, sql), 400);
    return () => clearTimeout(h);
  }, [sql, tab.id]);

  // Switching active tabs unmounts this view. Flush the latest value so a
  // switch inside the debounce window cannot lose text. A deliberately closed
  // tab has already been removed from the store and must stay cleaned up.
  useEffect(
    () => () => {
      if (useWorkspace.getState().tabs.some((item) => item.id === tab.id)) {
        persistBuffer(tab.id, latestSqlRef.current);
      }
    },
    [tab.id]
  );
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const [sessionStatus, setSessionStatus] = useState({ connected: false, in_transaction: false });
  const [backendNeedsReset, setBackendNeedsReset] = useState(false);
  const [stopConfirm, setStopConfirm] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [pendingTargetId, setPendingTargetId] = useState<string | null>(null);
  const [pins, setPins] = useState<Array<{ id: string; result: QueryResult; label: string }>>([]);
  const [comparePins, setComparePins] = useState(false);
  const sessionTarget = useRef<string>();
  useEffect(() => {
    useWorkspace.setState((workspace) => ({tabs: workspace.tabs.map((item) => item.id === tab.id && item.transactionOpen !== sessionStatus.in_transaction ? {...item, transactionOpen: sessionStatus.in_transaction} : item)}));
  }, [tab.id, sessionStatus.in_transaction]);
  const connections = useConnections((s) => s.list);
  const statusMap = useConnections((s) => s.status);
  const [userTargetId, setUserTargetId] = useState<string | undefined>(
    tab.connectionId
  );
  const lastRunRef = useRef<number>(0);
  // Current run: backend query id (for cancel_query) + a cancelled flag the
  // statement loop checks so Stop also halts multi-statement scripts.
  const runSessionRef = useRef<{ qid: string; cancelled: boolean } | null>(null);
  // Filled by CodeMirrorEditor with a getter for the current selection text,
  // so toolbar actions (Explain) honor the same "selection wins" rule as ⌘↵.
  const selectionGetter = useRef<(() => string | undefined) | null>(null);
  const t = useT();

  useEffect(() => {
    const bound = sessionTarget.current;
    if (bound && statusMap[bound] !== "connected") {
      if (sessionStatus.in_transaction) setBackendNeedsReset(true);
      setSessionStatus((old) => old.connected ? {...old, connected: false} : old);
    }
  }, [statusMap, sessionStatus.in_transaction]);
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(
    null
  );
  const [explainMenu, setExplainMenu] = useState<{ x: number; y: number } | null>(
    null
  );
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null);
  const [connectingTarget, setConnectingTarget] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  // Below this width the toolbar collapses secondary labels to icons instead
  // of letting flex items squash their text into vertical stacks.
  const toolbarWidth = useElementWidth(toolbarRef);
  const compact = toolbarWidth > 0 && toolbarWidth < 720;
  // Non-read statement awaiting explicit confirmation before EXPLAIN ANALYZE.
  const [analyzeConfirm, setAnalyzeConfirm] = useState<string | null>(null);
  const [saveSnippetOpen, setSaveSnippetOpen] = useState(false);
  const [snippetName, setSnippetName] = useState("");
  const [snippetDesc, setSnippetDesc] = useState("");
  const [snippetError, setSnippetError] = useState<string | null>(null);

  useEffect(() => {
    const handleInsert = (e: Event) => {
      const customEvent = e as CustomEvent<string>;
      if (useWorkspace.getState().activeTabId === tab.id) {
        setSql((prev) => {
          const trimmed = prev.trim();
          if (!trimmed || trimmed === INITIAL.trim()) {
            return customEvent.detail;
          }
          return prev + "\n\n" + customEvent.detail;
        });
      }
    };
    window.addEventListener("insert-sql", handleInsert as EventListener);
    return () => window.removeEventListener("insert-sql", handleInsert as EventListener);
  }, [tab.id]);

  // Buffer refresh for reused tabs: "Show DDL" / history re-open an existing
  // tab id, which never remounts — the sessionStorage prime is only read in
  // the mount initializer, so senders also dispatch this event.
  useEffect(() => {
    const handler = (e: Event) => {
      const ce = e as CustomEvent<{ tabId: string; sql: string }>;
      if (ce.detail?.tabId === tab.id) setSql(ce.detail.sql);
    };
    window.addEventListener("set-editor-sql", handler);
    return () => window.removeEventListener("set-editor-sql", handler);
  }, [tab.id]);

  const handleSaveSnippet = async () => {
    if (!snippetName.trim()) {
      setSnippetError(t("snippets.err.name_required"));
      return;
    }
    try {
      await api.saveSnippet({
        id: "",
        name: snippetName.trim(),
        sql: sql.trim(),
        description: snippetDesc.trim() || undefined,
      });
      setSaveSnippetOpen(false);
      setSnippetName("");
      setSnippetDesc("");
      setSnippetError(null);
      window.dispatchEvent(new Event("snippets-updated"));
    } catch (e) {
      setSnippetError(String(e));
    }
  };

  const connected = useMemo(
    () => connections.filter((c) => statusMap[c.id] === "connected"),
    [connections, statusMap]
  );

  // Effective target: respect explicit user choice (if still connected),
  // else the tab's bound connection, else the only / first connected one.
  const targetId = useMemo<string | undefined>(() => {
    const isLive = (id?: string) =>
      !!id && connected.some((c) => c.id === id);
    if (userTargetId) return isLive(userTargetId) ? userTargetId : undefined;
    if (tab.connectionId) return isLive(tab.connectionId) ? tab.connectionId : undefined;
    return connected[0]?.id;
  }, [userTargetId, tab.connectionId, connected]);

  const targetCfg = useMemo(
    () => connections.find((c) => c.id === targetId),
    [connections, targetId]
  );

  // Schema hint for SQL autocomplete: { tableName: [colName, ...] }.
  // Table names come from the loaded branches (covers every loaded schema);
  // column names are fetched once per connection via describe_schema and merged
  // in, so completion suggests both `table` and `table.column` / columns.
  const branches = useConnections((s) => s.branches);
  const [colMap, setColMap] = useState<Record<string, string[]>>({});

  // Fetch column metadata for the target connection (cached per connection).
  useEffect(() => {
    if (!targetId) {
      setColMap({});
      return;
    }
    const cached = getSchemaColumns(targetId);
    if (cached) {
      setColMap(cached);
      return;
    }
    // Redis has no tabular schema; skip the describe round-trip.
    if (targetCfg?.driver === "redis") {
      setColMap({});
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const tables = await api.describeSchema(targetId, undefined, 200);
        const map: Record<string, string[]> = {};
        for (const tbl of tables) {
          map[tbl.name] = tbl.columns.map((c) => c.name);
        }
        setSchemaColumns(targetId, map);
        if (!cancelled) setColMap(map);
      } catch {
        // Autocomplete is best-effort; ignore describe failures.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [targetId, targetCfg?.driver]);

  const sqlSchema = useMemo<Record<string, string[]>>(() => {
    if (!targetId) return {};
    const b = branches[targetId];
    const out: Record<string, string[]> = {};
    // Start from loaded tree table names (all schemas), filling columns where known.
    if (b?.tables) {
      for (const entries of Object.values(b.tables)) {
        for (const e of entries) out[e.name] = colMap[e.name] ?? [];
      }
    }
    // Include any described tables not yet present in the tree cache.
    for (const [name, cols] of Object.entries(colMap)) {
      if (!(name in out)) out[name] = cols;
    }
    return out;
  }, [branches, targetId, colMap]);

  // Clear stale "no target" errors as soon as a target becomes available
  // (e.g. user just connected to a DB after opening this tab).
  useEffect(() => {
    if (
      state.kind === "error" &&
      state.message === t("query.placeholder") &&
      targetId
    ) {
      setState({ kind: "idle" });
    }
  }, [targetId, state, t]);

  const run = useCallback(
    async (opts?: { selection?: string; explain?: boolean }) => {
      // One run at a time. The Run→Stop button swap doesn't stop the ⌘↵
      // CodeMirror binding from re-invoking this mid-flight; without the
      // guard, whichever run settled LAST would own the result display.
      if (runSessionRef.current) return;
      if (!targetId) {
        setState({ kind: "error", message: t("query.placeholder") });
        return;
      }
      const sessionChanged = sessionTarget.current !== targetId;
      if (sessionTarget.current && sessionTarget.current !== targetId) {
        await api.closeEditorSession(tab.id);
        setBackendNeedsReset(false);
        setSessionStatus({ connected: false, in_transaction: false });
      }
      const now = Date.now();
      if (!sessionChanged && now - lastRunRef.current < 150) return;
      lastRunRef.current = now;

      const source = (opts?.selection ?? sql).trim();
      if (!source) return;
      sessionTarget.current = targetId;

      // Redis runs each line as one command; never split by `;`.
      const isRedis = targetCfg?.driver === "redis";

      let statements: string[];
      if (opts?.explain) {
        statements = [explainWrap(source, targetCfg?.driver ?? "")];
      } else if (isRedis) {
        statements = splitRedisCommands(source);
        if (statements.length === 0) statements = [source];
      } else {
        statements = splitStatements(source);
        if (statements.length === 0) statements = [source];
      }

      const session = { qid: crypto.randomUUID(), cancelled: false };
      runSessionRef.current = session;
      // Belt-and-braces: even if a future change lets sessions overlap, only
      // the session that still owns the ref may touch the result display.
      const owns = () => runSessionRef.current === session;

      // Multi-statement batches always go to the backend as one script so
      // they share a single connection: a per-statement loop over the pool can
      // land BEGIN and COMMIT on different connections, which silently
      // autocommits the writes in between. `atomic` decides whether rdbstudio
      // wraps them in its own transaction — a script with its own BEGIN/COMMIT
      // manages that itself.
      const managesOwnTxn = statements.some((s) =>
        /^(begin|commit|rollback|start\s+transaction|end)\b/i.test(stripLeadingComments(s))
      );
      const asScript = statements.length > 1 && !isRedis;

      setState({ kind: "running" });
      try {
        if (asScript) {
          const outcome = await api.executeScript(
            targetId,
            statements,
            session.qid,
            !managesOwnTxn,
            tab.id
          );
          if (!owns()) return;
          if (outcome.status === "failed") {
            // "The whole script was rolled back" is a promise only the
            // backend can make: MySQL commits DDL implicitly, and a script
            // with its own BEGIN/COMMIT was never ours to roll back.
            const heading = {
              complete: "query.err.statement_rolled_back",
              partial: "query.err.statement_partial_rollback",
              self_managed: "query.err.statement_self_managed",
            }[outcome.rollback];
            setState({
              kind: "error",
              message:
                t(heading, {
                  n: outcome.failed_index + 1,
                  m: outcome.statements,
                }) +
                "\n" +
                outcome.error,
              failedAt: outcome.failed_index,
            });
            return;
          }
          setState({
            kind: "ok",
            result: outcome.results?.at(-1) ?? outcome.result,
            results: outcome.results ?? [outcome.result],
            statements: {
              count: outcome.statements,
              affected_total: outcome.total_affected,
            },
          });
          return;
        }
        let last: QueryResult | null = null;
        let affected_total = 0;
        const results: QueryResult[] = [];
        for (let i = 0; i < statements.length; i++) {
          if (session.cancelled) {
            if (owns()) setState({ kind: "error", message: t("query.err.cancelled") });
            return;
          }
          try {
            last = await api.executeQuery(targetId, statements[i], session.qid, isRedis ? undefined : tab.id);
            results.push(last);
            if (last.rows_affected != null) affected_total += last.rows_affected;
          } catch (e) {
            if (!owns()) return;
            if (session.cancelled) {
              setState({ kind: "error", message: t("query.err.cancelled") });
              return;
            }
            // Tag which statement of the batch broke so the UI can hint at it.
            const prefix =
              statements.length > 1
                ? t("query.err.statement", { n: i + 1, m: statements.length }) +
                  "\n"
                : "";
            setState({
              kind: "error",
              message: prefix + String(e),
              failedAt: i,
            });
            return;
          }
        }
        if (!owns()) return;
        if (!last) {
          setState({ kind: "error", message: t("query.placeholder") });
          return;
        }
        setState({
          kind: "ok",
          result: last,
          results,
          statements:
            statements.length > 1
              ? { count: statements.length, affected_total }
              : undefined,
        });
      } catch (e) {
        if (owns())
          setState({
            kind: "error",
            message: session.cancelled ? t("query.err.cancelled") : String(e),
          });
      } finally {
        if (runSessionRef.current === session) runSessionRef.current = null;
        void api.editorSessionStatus(tab.id).then((next) => { if (next) { setSessionStatus(next); if (next.needs_reset) setBackendNeedsReset(true); } }).catch(() => {});
      }
    },
    [sql, targetId, targetCfg, t, tab.id]
  );

  // Visual EXPLAIN: PG, MySQL (FORMAT=JSON) and SQLite plans open as a graph
  // tab; ExplainView parses per driver and surfaces server errors. Redis keeps
  // the button disabled and any other driver falls back to text EXPLAIN.
  const openExplainTab = useCallback(
    (source: string, analyze: boolean) => {
      if (!targetId) {
        setState({ kind: "error", message: t("query.placeholder") });
        return;
      }
      useWorkspace.getState().openTab({
        id: `${analyze ? "explain-analyze" : "explain"}:${crypto.randomUUID()}`,
        kind: "explain",
        title: analyze ? t("explain.analyze.title") : t("explain.title"),
        subtitle: targetCfg?.name,
        connectionId: targetId,
        sql: source,
      });
    },
    [targetId, targetCfg, t]
  );

  // Same source rule as run(): editor selection wins over the buffer.
  const explainSource = useCallback(
    () => (selectionGetter.current?.() ?? sql).trim(),
    [sql]
  );

  const onExplain = useCallback(() => {
    const driver = targetCfg?.driver;
    if (driver === "postgres" || driver === "sqlite" || driver === "mysql") {
      const source = explainSource();
      if (!source) return;
      openExplainTab(source, false);
      return;
    }
    void run({ explain: true });
  }, [targetCfg, explainSource, openExplainTab, run]);

  // EXPLAIN ANALYZE runs the statement for real: only PostgreSQL offers it
  // (SQLite has no query-plan ANALYZE; MySQL's text tree is out of scope).
  // The read-only classifier fails closed, so anything that is not a plain
  // SELECT / WITH / VALUES / TABLE asks for explicit confirmation first.
  const onExplainAnalyze = useCallback(() => {
    if (targetCfg?.driver !== "postgres") return;
    const source = explainSource();
    if (!source) return;
    if (!isReadOnlyStatement(source)) {
      setAnalyzeConfirm(source);
      return;
    }
    openExplainTab(source, true);
  }, [targetCfg, explainSource, openExplainTab]);

  const onStop = useCallback(() => {
    const session = runSessionRef.current;
    if (!session) return;
    session.cancelled = true;
    void api.cancelQuery(session.qid).catch(() => {
      /* the statement may have just finished; the cancelled flag still stops the loop */
    });
  }, []);

  const onExport = async (format: "csv" | "json" | "sql") => {
    if (state.kind !== "ok" || state.result.rows.length === 0) return;
    const names = state.result.columns.map((c) => c.name);
    const base = (tab.title || "result").replace(/[^\w.-]+/g, "_");
    let text: string;
    if (format === "json") {
      text = toJSONRows(names, state.result.rows);
    } else if (format === "sql") {
      // No real table behind an ad-hoc result — use the sanitized tab title
      // as the INSERT target; trivial to search-replace after pasting.
      text = toInsertSql(targetCfg?.driver, base, names, state.result.rows);
    } else {
      text = toCSV(names, state.result.rows);
    }
    try {
      await saveTextFile(`${base}.${format}`, text, format);
    } catch (e) {
      setState({
        kind: "error",
        message: t("query.err.export", { error: String(e) }),
      });
    }
  };

  const onFormat = useCallback(() => {
    const language: Parameters<typeof formatSql>[1] = (() => {
      switch (targetCfg?.driver) {
        case "postgres":
          return { language: "postgresql" };
        case "mysql":
          return { language: "mysql" };
        case "sqlite":
          return { language: "sqlite" };
        default:
          return { language: "sql" };
      }
    })();
    try {
      // sql-formatter throws on syntactically broken input; fall back to the
      // raw text rather than wiping the editor on transient typos.
      const out = formatSql(sql, {
        ...language,
        keywordCase: "upper",
        tabWidth: 2,
      });
      setSql(out);
    } catch {
      /* keep as-is; user will see no change rather than a destroyed buffer */
    }
  }, [sql, targetCfg?.driver]);

  const chooseTarget = async (nextId: string) => {
    const next = nextId || undefined;
    if (next && useConnections.getState().status[next] !== "connected") {
      setConnectingTarget(true);
      try {
        await useConnections.getState().connect(next);
      } catch (error) {
        setState({ kind: "error", message: String(error) });
        return;
      } finally {
        setConnectingTarget(false);
      }
    }
    if (sessionTarget.current && sessionTarget.current !== next && sessionStatus.in_transaction) {
      setPendingTargetId(nextId);
      return;
    }
    if (sessionTarget.current && sessionTarget.current !== next) {
      try {
        await api.closeEditorSession(tab.id);
        sessionTarget.current = undefined;
        setBackendNeedsReset(false);
        setSessionStatus({ connected: false, in_transaction: false });
      } catch (error) {
        setState({ kind: "error", message: String(error) });
        return;
      }
    }
    setUserTargetId(next);
  };

  const confirmTargetChange = async () => {
    const next = pendingTargetId || undefined;
    setPendingTargetId(null);
    try {
      await api.closeEditorSession(tab.id);
      sessionTarget.current = undefined;
      setBackendNeedsReset(false);
      setSessionStatus({ connected: false, in_transaction: false });
      setUserTargetId(next);
    } catch (error) {
      setState({ kind: "error", message: String(error) });
    }
  };

  // ⌘⇧F from the global shortcut layer formats the active tab's buffer.
  useEffect(() => {
    const handler = () => {
      if (useWorkspace.getState().activeTabId === tab.id) onFormat();
    };
    window.addEventListener("format-sql", handler);
    return () => window.removeEventListener("format-sql", handler);
  }, [tab.id, onFormat]);

  const gridColumns: GridColumn[] =
    state.kind === "ok"
      ? state.result.columns.map((c) => ({
          name: c.name,
          data_type: c.data_type,
        }))
      : [];
  const gridRows = state.kind === "ok" ? state.result.rows : [];
  const sessionLost = backendNeedsReset || !!targetId && sessionTarget.current === targetId && !sessionStatus.connected && sessionStatus.in_transaction;

  const running = state.kind === "running";
  const isRedis = targetCfg?.driver === "redis";
  const txBusy = !targetId || !!targetCfg?.read_only || running || sessionLost;

  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={(e) => {
        // CodeMirror owns ⌘↵ while focused; elsewhere in the tab (toolbar,
        // result grid) the same chord still runs the buffer.
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !(e.target as HTMLElement).closest(".cm-editor")) {
          e.preventDefault();
          if (!running) void run();
        }
      }}
    >
      <div
        ref={toolbarRef}
        className="flex h-11 shrink-0 items-center gap-1.5 border-b border-border/70 bg-surface/30 px-2.5"
      >
        {running ? (
          <button
            onClick={() => (sessionStatus.in_transaction ? setStopConfirm(true) : onStop())}
            className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-danger/90 px-2.5 text-[12px] font-medium text-white shadow-soft transition-colors hover:bg-danger"
          >
            <Square className="h-3 w-3 fill-current" />
            {t("query.toolbar.stop")}
          </button>
        ) : (
          <button
            onClick={() => void run()}
            disabled={!targetId}
            title={`${t("query.toolbar.run")} (${modKey}↵)`}
            className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md bg-brand px-2.5 text-[12px] font-medium text-brand-foreground shadow-soft transition-colors hover:bg-brand/90 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            {t("query.toolbar.run")}
            {!compact && (
              <kbd className="rounded bg-black/15 px-1 font-sans text-[10px] font-normal">{modKey}↵</kbd>
            )}
          </button>
        )}

        {targetCfg && !isRedis && (
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-border/60 bg-background/40 p-0.5">
            {sessionLost ? (
              <>
                <span className="flex items-center gap-1 whitespace-nowrap px-1.5 text-[11px] font-medium text-danger">
                  <Unplug className="h-3 w-3" />
                  {t("query.tx.lost")}
                </span>
                <ToolButton icon={RotateCcw} label={t("query.tx.reset")} compact={compact} disabled={running} onClick={() => setResetConfirm(true)} />
              </>
            ) : sessionStatus.in_transaction ? (
              <>
                <span className="flex items-center gap-1.5 whitespace-nowrap rounded-md bg-warning/15 px-2 py-1 text-[11px] font-medium text-warning">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
                  {t("query.tx.open")}
                </span>
                <ToolButton icon={Check} label={t("query.tx.commit")} compact={compact} disabled={txBusy || !sessionStatus.connected} onClick={() => void run({ selection: "COMMIT" })} className="hover:text-success" />
                <ToolButton icon={Undo2} label={t("query.tx.rollback")} compact={compact} disabled={txBusy || !sessionStatus.connected} onClick={() => void run({ selection: "ROLLBACK" })} className="hover:text-danger" />
              </>
            ) : (
              <ToolButton icon={ListStart} label={t("query.tx.begin")} compact={compact} disabled={txBusy} onClick={() => void run({ selection: "BEGIN" })} />
            )}
          </div>
        )}

        <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />

        <div className="flex shrink-0 items-center">
          <ToolButton
            icon={ListTree}
            label={t("query.toolbar.explain")}
            compact={compact}
            onClick={onExplain}
            disabled={running || !targetId || isRedis}
            title={isRedis ? t("query.toolbar.explain_na") : t("query.toolbar.explain")}
          />
          {targetCfg?.driver === "postgres" && (
            <button
              onClick={(e) => setExplainMenu({ x: e.clientX, y: e.clientY })}
              disabled={running || !targetId}
              title={t("query.toolbar.explain_options")}
              aria-label={t("query.toolbar.explain_options")}
              className="flex h-7 items-center rounded-md px-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            >
              <ChevronDown className="h-3 w-3" />
            </button>
          )}
        </div>
        {explainMenu && (
          <ContextMenu
            x={explainMenu.x}
            y={explainMenu.y}
            items={
              [
                {
                  id: "explain",
                  label: t("query.toolbar.explain"),
                  icon: ListTree,
                  onClick: onExplain,
                },
                {
                  id: "explain-analyze",
                  label: t("query.toolbar.explain_analyze"),
                  icon: Play,
                  danger: true,
                  onClick: onExplainAnalyze,
                },
              ] satisfies MenuEntry[]
            }
            onClose={() => setExplainMenu(null)}
          />
        )}
        <ToolButton
          icon={WandSparkles}
          label={t("query.toolbar.format")}
          compact={compact}
          onClick={onFormat}
          disabled={!sql.trim() || isRedis}
          title={isRedis ? t("query.toolbar.format_na") : `${t("query.toolbar.format")} (${modKey}⇧F)`}
        />
        <ToolButton
          icon={BookmarkPlus}
          label={t("query.toolbar.save_snippet")}
          compact={compact}
          onClick={() => setSaveSnippetOpen(true)}
          disabled={!sql.trim()}
        />

        <div className="min-w-2 flex-1" />

        <label
          title={t("query.toolbar.target")}
          className={cn(
            "flex h-7 min-w-0 max-w-[240px] shrink items-center gap-1.5 rounded-md border pl-2 pr-1 text-[12px] transition-colors focus-within:border-brand/60",
            targetId ? "border-border/70 bg-surface" : "border-warning/60 bg-warning/10 text-warning"
          )}
        >
          {targetCfg ? (
            <span
              className="h-4 w-[3px] shrink-0 rounded-full"
              style={{ background: connColorValue(targetCfg.color) ?? "hsl(var(--border))" }}
            />
          ) : (
            <Database className="h-3.5 w-3.5 shrink-0" />
          )}
          <select
            value={targetId ?? ""}
            disabled={running || connectingTarget}
            onChange={(e) => void chooseTarget(e.target.value)}
            aria-label={t("query.toolbar.target")}
            className="min-w-0 flex-1 cursor-pointer truncate bg-transparent pr-1 text-foreground outline-none"
          >
            <option value="">
              {connections.length === 0
                ? t("query.toolbar.no_connections")
                : t("query.toolbar.pick_target")}
            </option>
            {connected.length > 0 && (
              <optgroup label={t("query.toolbar.group_connected")}>
                {connected.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
            {connections.length > connected.length && (
              <optgroup label={t("query.toolbar.group_disconnected")}>
                {connections
                  .filter((c) => statusMap[c.id] !== "connected")
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
          {connectingTarget && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />}
        </label>
        <button
          onClick={(e) => setMoreMenu({ x: e.clientX, y: e.clientY })}
          title={t("common.more")}
          aria-label={t("common.more")}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Ellipsis className="h-4 w-4" />
        </button>
        {moreMenu && (
          <ContextMenu
            x={moreMenu.x}
            y={moreMenu.y}
            items={[
              {
                id: "open_sql_file", label: t("table_tools.open_sql"), icon: FolderOpen,
                disabled: running || isRedis,
                onClick: () => void openSqlFile(targetId).catch((cause) => toast.error(t("table_tools.open_sql_failed"), String(cause))),
              },
              {
                id: "save_sql_file", label: t("query.save_sql_file"), icon: Save,
                disabled: running || isRedis,
                onClick: () => void saveTextFile(`${tab.title.replace(/\.sql$/i, "") || "query"}.sql`, sql, "sql")
                  .catch((cause) => toast.error(t("query.save_sql_file_failed"), String(cause))),
              },
              {
                id: "reset",
                label: t("query.tx.reset"),
                icon: RotateCcw,
                danger: true,
                disabled: running || isRedis || !targetId,
                onClick: () => setResetConfirm(true),
              },
            ]}
            onClose={() => setMoreMenu(null)}
          />
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-[140px] flex-1 border-b border-border/60">
          <CodeMirrorEditor
            value={sql}
            onChange={setSql}
            onRun={(opts) => void run(opts)}
            schema={sqlSchema}
            selectionGetter={selectionGetter}
          />
        </div>
        <div className="flex h-[40%] min-h-[180px] shrink-0 flex-col bg-background">
          <ResultHeader state={state} targetName={targetCfg?.name} />
          {(state.kind === "ok" || pins.length > 0) && (
            <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/70 px-2 text-[11.5px]">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
                {state.kind === "ok" &&
                  (state.results ?? [state.result]).map((result, index) => (
                    <button
                      key={index}
                      onClick={() => setState({ ...state, result })}
                      className={cn(
                        "flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-muted-foreground hover:bg-accent hover:text-foreground",
                        state.result === result && "bg-brand/15 text-brand hover:bg-brand/20 hover:text-brand"
                      )}
                    >
                      {t("query.result.tab", { n: index + 1 })}
                      <span className="text-[10.5px] opacity-70">
                        {result.columns.length
                          ? t("query.result.rows_short", { n: result.rows.length })
                          : t("query.result.affected_short", { n: result.rows_affected ?? 0 })}
                      </span>
                    </button>
                  ))}
              </div>
              {state.kind === "ok" && (
                <ToolButton
                  icon={Pin}
                  label={t("query.result.pin")}
                  compact={compact}
                  onClick={() =>
                    setPins((prev) => [
                      ...prev.slice(-3),
                      {
                        id: crypto.randomUUID(),
                        result: state.result,
                        label: `${tab.title} · ${new Date().toLocaleTimeString()}`,
                      },
                    ])
                  }
                />
              )}
              {pins.length > 0 && (
                <ToolButton
                  icon={Columns2}
                  label={t("query.result.compare", { n: pins.length })}
                  compact={compact}
                  onClick={() => setComparePins(!comparePins)}
                  className={cn(comparePins && "bg-accent text-foreground")}
                />
              )}
              <ToolButton
                icon={Download}
                label={t("query.toolbar.export")}
                compact={compact}
                onClick={(e) => setExportMenu({ x: e.clientX, y: e.clientY })}
                disabled={state.kind !== "ok" || state.result.rows.length === 0}
              />
              {exportMenu && (
                <ContextMenu
                  x={exportMenu.x}
                  y={exportMenu.y}
                  items={[
                    { id: "csv", label: t("query.toolbar.export_csv"), onClick: () => void onExport("csv") },
                    { id: "json", label: t("query.toolbar.export_json"), onClick: () => void onExport("json") },
                    { id: "sql", label: t("query.toolbar.export_sql"), onClick: () => void onExport("sql") },
                  ]}
                  onClose={() => setExportMenu(null)}
                />
              )}
            </div>
          )}
          {comparePins && pins.length > 0 && (
            <div className="flex h-44 min-h-[160px] shrink-0 divide-x divide-border border-b border-border">
              {pins.slice(-2).map((pin) => (
                <div key={pin.id} className="flex min-w-0 flex-1 flex-col">
                  <div className="flex h-7 shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-surface-muted/30 px-2 text-[11px] text-muted-foreground">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <Pin className="h-3 w-3 shrink-0" />
                      <span className="truncate">{pin.label}</span>
                    </span>
                    <button
                      aria-label={t("query.result.unpin")}
                      title={t("query.result.unpin")}
                      onClick={() => setPins(pins.filter((p) => p.id !== pin.id))}
                      className="grid h-5 w-5 place-items-center rounded hover:bg-accent hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1">
                    <DataGrid columns={pin.result.columns} rows={pin.result.rows} driver={targetCfg?.driver} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {state.kind === "ok" && state.result.truncated && (
            <div className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11.5px] text-warning">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {t("query.result.truncated", { n: state.result.rows.length })}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {state.kind === "ok" && state.result.columns.length > 0 && (
              <DataGrid
                columns={gridColumns}
                rows={gridRows}
                driver={targetCfg?.driver}
              />
            )}
            {state.kind === "ok" && state.result.columns.length === 0 && (
              <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                {state.result.rows_affected != null
                  ? t("query.result.executed_affected", {
                      n: state.result.rows_affected,
                    })
                  : t("query.result.executed")}
              </div>
            )}
            {state.kind === "error" && (
              <div className="flex h-full items-start justify-center p-6">
                <div className="max-w-lg rounded-lg border border-danger/40 bg-danger/10 p-4 text-[12.5px]">
                  <div className="mb-1 flex items-center gap-2 font-medium text-danger">
                    <AlertTriangle className="h-4 w-4" />
                    {t("query.err.title")}
                  </div>
                  <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-foreground/90">
                    {state.message}
                  </pre>
                </div>
              </div>
            )}
            {state.kind === "idle" && (
              <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
                {t("query.result.idle")}
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={stopConfirm}
        title={t("query.stop_tx.title")}
        message={t("query.stop_tx.message")}
        confirmLabel={t("query.stop_tx.confirm")}
        cancelLabel={t("query.stop_tx.keep")}
        danger
        onConfirm={onStop}
        onClose={() => setStopConfirm(false)}
      />
      <ConfirmDialog
        open={resetConfirm}
        title={t("query.reset.title")}
        message={t("query.reset.message")}
        confirmLabel={t("query.reset.confirm")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => {
          void api
            .closeEditorSession(tab.id)
            .then(() => {
              sessionTarget.current = undefined;
              setBackendNeedsReset(false);
              setSessionStatus({ connected: false, in_transaction: false });
            })
            .catch((error) => setState({ kind: "error", message: String(error) }));
        }}
        onClose={() => setResetConfirm(false)}
      />
      <ConfirmDialog
        open={pendingTargetId != null}
        title={t("query.switch_tx.title")}
        message={t("query.switch_tx.message")}
        confirmLabel={t("query.switch_tx.confirm")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => void confirmTargetChange()}
        onClose={() => setPendingTargetId(null)}
      />
      <Modal
        open={saveSnippetOpen}
        onClose={() => setSaveSnippetOpen(false)}
        title={t("sidebar.snippets.new")}
        width={460}
        footer={
          <>
            <Button onClick={() => setSaveSnippetOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" onClick={handleSaveSnippet}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <div className="space-y-3.5">
          {snippetError && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {snippetError}
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              {t("sidebar.snippets.name")} *
            </label>
            <input
              type="text"
              value={snippetName}
              onChange={(e) => setSnippetName(e.target.value)}
              className="h-8 rounded-md border border-border/70 bg-surface px-3 text-[12.5px] text-foreground focus:border-brand/60 focus:outline-none"
              placeholder={t("snippets.name_placeholder")}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-[12px] font-medium text-foreground">
              {t("sidebar.snippets.desc")}
            </label>
            <input
              type="text"
              value={snippetDesc}
              onChange={(e) => setSnippetDesc(e.target.value)}
              className="h-8 rounded-md border border-border/70 bg-surface px-3 text-[12.5px] text-foreground focus:border-brand/60 focus:outline-none"
              placeholder={t("snippets.desc_placeholder")}
            />
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={analyzeConfirm != null}
        title={t("explain.analyze.warning_title")}
        message={t("explain.analyze.warning")}
        confirmLabel={t("explain.analyze.proceed")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => {
          if (analyzeConfirm != null) openExplainTab(analyzeConfirm, true);
        }}
        onClose={() => setAnalyzeConfirm(null)}
      />
    </div>
  );
}

function ResultHeader({ state, targetName }: { state: RunState; targetName?: string }) {
  const t = useT();
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/60 bg-surface-muted/30 px-3 text-[11.5px] text-muted-foreground">
      {state.kind === "running" && (
        <span className="flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t("query.state.running")}
        </span>
      )}
      {state.kind === "ok" && state.statements && (
        <span className="flex items-center gap-1.5 text-success">
          <CheckCircle2 className="h-3 w-3" />
          {t("query.result.statements", {
            n: state.statements.count,
            affected: state.statements.affected_total,
          })}
          <span className="text-muted-foreground">
            · {state.result.elapsed_ms}ms
          </span>
        </span>
      )}
      {state.kind === "ok" && !state.statements && (
        <span className="flex items-center gap-1.5 text-success">
          <CheckCircle2 className="h-3 w-3" />
          {state.result.columns.length > 0
            ? t("query.result.rows", { n: state.result.rows.length })
            : state.result.rows_affected != null
            ? t("query.result.affected", { n: state.result.rows_affected })
            : t("common.ok")}
          <span className="text-muted-foreground">
            · {state.result.elapsed_ms}ms
          </span>
        </span>
      )}
      {state.kind === "error" && (
        <span className="flex items-center gap-1.5 text-danger">
          <AlertTriangle className="h-3 w-3" />
          {t("query.state.failed")}
        </span>
      )}
      <div className="flex-1" />
      {targetName && (
        <span className="truncate text-[11px] text-muted-foreground/80">{targetName}</span>
      )}
    </div>
  );
}

function ToolButton({
  icon: Icon,
  label,
  compact,
  className,
  title,
  ...props
}: {
  icon: LucideIcon;
  label: string;
  compact?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      {...props}
      className={cn(
        "flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 text-[12px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        className
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {!compact && <span>{label}</span>}
    </button>
  );
}
