import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Loader2,
  Play,
  Sparkles,
  Square,
  TableProperties,
  FileCode,
} from "lucide-react";
import { format as formatSql } from "sql-formatter";
import type { WorkspaceTab } from "@/types";
import { api, type QueryResult } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { CodeMirrorEditor } from "@/components/editor/CodeMirror";
import { DataGrid, type GridColumn } from "@/components/grid/DataGrid";
import { saveTextFile, toCSV } from "@/lib/csv";
import { explainWrap, splitStatements } from "@/lib/sql";
import { getSchemaColumns, setSchemaColumns } from "@/lib/schemaCache";
import { cn } from "@/lib/cn";
import { useT } from "@/store/i18n";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";

type RunState =
  | { kind: "idle" }
  | { kind: "running" }
  | {
      kind: "ok";
      result: QueryResult;
      // For multi-statement scripts: how many statements ran in total, and a summary.
      statements?: { count: number; affected_total: number };
    }
  | { kind: "error"; message: string; failedAt?: number };

const INITIAL = `-- ⌘↵ runs the query. Select text to run just that.
SELECT 1 AS hello, 'world' AS greet;`;

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

export function QueryEditorView({ tab }: { tab: WorkspaceTab }) {
  const [sql, setSql] = useState(() => primedFor(tab.id) ?? INITIAL);
  const [state, setState] = useState<RunState>({ kind: "idle" });
  const connections = useConnections((s) => s.list);
  const statusMap = useConnections((s) => s.status);
  const [userTargetId, setUserTargetId] = useState<string | undefined>(
    tab.connectionId
  );
  const lastRunRef = useRef<number>(0);
  // Current run: backend query id (for cancel_query) + a cancelled flag the
  // statement loop checks so Stop also halts multi-statement scripts.
  const runSessionRef = useRef<{ qid: string; cancelled: boolean } | null>(null);
  const t = useT();

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

  const handleSaveSnippet = async () => {
    if (!snippetName.trim()) {
      setSnippetError("Name is required");
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
    if (isLive(userTargetId)) return userTargetId;
    if (isLive(tab.connectionId)) return tab.connectionId;
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
      if (!targetId) {
        setState({ kind: "error", message: t("query.placeholder") });
        return;
      }
      const now = Date.now();
      if (now - lastRunRef.current < 150) return;
      lastRunRef.current = now;

      const source = (opts?.selection ?? sql).trim();
      if (!source) return;

      // Redis runs each line as one command; never split by `;`.
      const isRedis = targetCfg?.driver === "redis";

      let statements: string[];
      if (opts?.explain) {
        statements = [explainWrap(source, targetCfg?.driver ?? "")];
      } else if (isRedis) {
        statements = [source];
      } else {
        statements = splitStatements(source);
        if (statements.length === 0) statements = [source];
      }

      const session = { qid: crypto.randomUUID(), cancelled: false };
      runSessionRef.current = session;

      setState({ kind: "running" });
      try {
        let last: QueryResult | null = null;
        let affected_total = 0;
        for (let i = 0; i < statements.length; i++) {
          if (session.cancelled) {
            setState({ kind: "error", message: t("query.err.cancelled") });
            return;
          }
          try {
            last = await api.executeQuery(targetId, statements[i], session.qid);
            if (last.rows_affected != null) affected_total += last.rows_affected;
          } catch (e) {
            if (session.cancelled) {
              setState({ kind: "error", message: t("query.err.cancelled") });
              return;
            }
            // Tag which statement of the batch broke so the UI can hint at it.
            const prefix =
              statements.length > 1
                ? `Statement ${i + 1} of ${statements.length} failed:\n`
                : "";
            setState({
              kind: "error",
              message: prefix + String(e),
              failedAt: i,
            });
            return;
          }
        }
        if (!last) {
          setState({ kind: "error", message: t("query.placeholder") });
          return;
        }
        setState({
          kind: "ok",
          result: last,
          statements:
            statements.length > 1
              ? { count: statements.length, affected_total }
              : undefined,
        });
      } catch (e) {
        setState({ kind: "error", message: String(e) });
      } finally {
        if (runSessionRef.current === session) runSessionRef.current = null;
      }
    },
    [sql, targetId, targetCfg, t]
  );

  const onStop = useCallback(() => {
    const session = runSessionRef.current;
    if (!session) return;
    session.cancelled = true;
    void api.cancelQuery(session.qid).catch(() => {
      /* the statement may have just finished; the cancelled flag still stops the loop */
    });
  }, []);

  const onExport = async () => {
    if (state.kind !== "ok" || state.result.rows.length === 0) return;
    const csv = toCSV(
      state.result.columns.map((c) => c.name),
      state.result.rows
    );
    try {
      await saveTextFile(`${tab.title || "result"}.csv`, csv, "csv");
    } catch (e) {
      setState({ kind: "error", message: `Export failed: ${String(e)}` });
    }
  };

  const onFormat = () => {
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
  };

  const gridColumns: GridColumn[] =
    state.kind === "ok"
      ? state.result.columns.map((c) => ({
          name: c.name,
          data_type: c.data_type,
        }))
      : [];
  const gridRows = state.kind === "ok" ? state.result.rows : [];

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-surface/30 px-3">
        {state.kind === "running" ? (
          <button
            onClick={onStop}
            className="flex h-7 items-center gap-1.5 rounded-md bg-danger/90 px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-danger"
          >
            <Square className="h-3 w-3 fill-current" />
            {t("query.toolbar.stop")}
          </button>
        ) : (
          <button
            onClick={() => void run()}
            disabled={!targetId}
            className="flex h-7 items-center gap-1.5 rounded-md bg-brand px-2.5 text-[12px] font-medium text-brand-foreground transition-colors hover:bg-brand/90 disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {t("query.toolbar.run")}
            <span className="ml-1 rounded bg-black/20 px-1 text-[10px]">⌘↵</span>
          </button>
        )}
        <button
          onClick={() => void run({ explain: true })}
          disabled={
            state.kind === "running" ||
            !targetId ||
            targetCfg?.driver === "redis"
          }
          title={
            targetCfg?.driver === "redis"
              ? "EXPLAIN is not applicable to Redis"
              : t("query.toolbar.explain")
          }
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <TableProperties className="h-3.5 w-3.5" />
          {t("query.toolbar.explain")}
        </button>
        <button
          onClick={onFormat}
          disabled={!sql.trim() || targetCfg?.driver === "redis"}
          title={
            targetCfg?.driver === "redis"
              ? "Formatting is not applicable to Redis commands"
              : "Format SQL"
          }
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Format
        </button>
        <button
          onClick={() => setSaveSnippetOpen(true)}
          disabled={!sql.trim()}
          title="Save as Snippet"
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <FileCode className="h-3.5 w-3.5" />
          Save Snippet
        </button>
        <div className="mx-2 h-4 w-px bg-border" />
        <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          {t("query.toolbar.target")}
          <select
            value={targetId ?? ""}
            onChange={(e) => setUserTargetId(e.target.value || undefined)}
            className={cn(
              "h-7 rounded-md border bg-surface px-2 text-[12px] text-foreground focus:border-brand/60 focus:outline-none",
              targetId
                ? "border-border/70"
                : "border-warning/60 bg-warning/10 text-warning"
            )}
          >
            <option value="">
              {connected.length === 0
                ? t("query.toolbar.no_connections")
                : t("query.toolbar.pick_target")}
            </option>
            {connected.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex-1" />
        <button
          onClick={onExport}
          disabled={state.kind !== "ok" || state.result.rows.length === 0}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
        >
          <Download className="h-3.5 w-3.5" />
          {t("query.toolbar.export_csv")}
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-[140px] flex-1 border-b border-border/60">
          <CodeMirrorEditor
            value={sql}
            onChange={setSql}
            onRun={(opts) => void run(opts)}
            schema={sqlSchema}
          />
        </div>
        <div className="flex h-[40%] min-h-[180px] shrink-0 flex-col bg-background">
          <ResultHeader state={state} tab={tab} />
          {state.kind === "ok" && state.result.truncated && (
            <div className="flex shrink-0 items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-1.5 text-[11.5px] text-warning">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {t("query.result.truncated", { n: state.result.rows.length })}
            </div>
          )}
          <div className="min-h-0 flex-1">
            {state.kind === "ok" && state.result.columns.length > 0 && (
              <DataGrid columns={gridColumns} rows={gridRows} />
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
              placeholder="e.g. Find users by email"
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
              placeholder="Optional description"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

function ResultHeader({ state, tab }: { state: RunState; tab: WorkspaceTab }) {
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
          {state.statements.count} statements ·{" "}
          {state.statements.affected_total} affected
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
      <span>{tab.title}</span>
    </div>
  );
}

