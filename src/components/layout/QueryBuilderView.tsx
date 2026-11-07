import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, Plus, RefreshCw, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { compileQuery, emptyGroup, emptyQuery, QueryBuilderError, type BuilderDraft, type QueryDesign, type QuerySource } from "@/lib/queryBuilder";
import { useConnections } from "@/store/connections";
import { nextQueryTitle, useWorkspace } from "@/store/workspace";
import { useT } from "@/store/i18n";
import type { ColumnInfo, TreeEntry, WorkspaceTab } from "@/types";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { SchemaPicker, ToolCard, ToolSelect } from "@/components/tools/ToolKit";
import { builderInput, defaultColumn, ExpressionEditor, type ExpressionContext } from "@/components/query-builder/ExpressionEditor";
import { ConditionEditor, RemoveButton, smallButton } from "@/components/query-builder/ConditionEditor";

export function QueryBuilderView({ tab }: { tab: WorkspaceTab }) {
  const t = useT();
  const connections = useConnections(s => s.list);
  const statuses = useConnections(s => s.status);
  const connect = useConnections(s => s.connect);
  const [draft, setDraft] = useState<BuilderDraft>(() => tab.builder ?? {
    version: 1, connectionId: tab.connectionId ?? "", catalogSchema: tab.schema ?? "", query: emptyQuery(),
  });
  const [pendingConnection, setPendingConnection] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [connectError, setConnectError] = useState("");
  const connectionGeneration = useRef(0);
  const connection = connections.find(c => c.id === draft.connectionId && c.driver !== "redis");
  const connected = !!connection && statuses[connection.id] === "connected";
  const query = draft.query;
  const catalogKey = JSON.stringify([draft.connectionId, draft.catalogSchema, connected, revision]);
  const [catalog, setCatalog] = useState<{ key: string; entries: TreeEntry[]; error: string; loading: boolean }>({ key: "", entries: [], error: "", loading: false });
  const sourceKey = JSON.stringify(query.sources.map(({ id, name, schema }) => ({ id, name, schema })));
  const metadataKey = JSON.stringify([draft.connectionId, sourceKey, connected, revision]);
  const [metadata, setMetadata] = useState<{ key: string; columns: Record<string, ColumnInfo[]>; error: string }>({ key: "", columns: {}, error: "" });
  const columnCache = useRef(new Map<string, ColumnInfo[]>());

  const change = (next: BuilderDraft) => {
    setDraft(next);
    useWorkspace.setState(state => ({ tabs: state.tabs.map(item => item.id === tab.id ? { ...item, builder: next, connectionId: next.connectionId || undefined } : item) }));
  };
  const changeQuery = (next: QueryDesign) => change({ ...draft, query: next });
  const selectConnection = (connectionId: string) => {
    connectionGeneration.current += 1;
    setConnectError("");
    columnCache.current.clear();
    change({ version: 1, connectionId, catalogSchema: "", query: emptyQuery() });
  };
  useEffect(() => () => { connectionGeneration.current += 1; }, []);

  useEffect(() => {
    let current = true;
    const [connectionId, schema, live] = JSON.parse(catalogKey) as [string, string, boolean, number];
    setCatalog({ key: catalogKey, entries: [], error: "", loading: live });
    if (!live) return;
    void api.listTables(connectionId, schema || undefined).then(entries => {
      if (current) setCatalog({ key: catalogKey, entries: entries.filter(entry => entry.kind === "table" || entry.kind === "view"), error: "", loading: false });
    }).catch(error => { if (current) setCatalog({ key: catalogKey, entries: [], error: String(error), loading: false }); });
    return () => { current = false; };
  }, [catalogKey]);

  useEffect(() => {
    let current = true;
    const [connectionId, serialized, live, refresh] = JSON.parse(metadataKey) as [string, string, boolean, number];
    const sources = JSON.parse(serialized) as Array<Pick<QuerySource, "id" | "name" | "schema">>;
    if (!live) { setMetadata({ key: metadataKey, columns: {}, error: "" }); return; }
    // Reuse metadata across alias/condition edits and additions, including self joins.
    const pending = new Map<string, Promise<ColumnInfo[]>>();
    void Promise.all(sources.map(async source => {
      const key = JSON.stringify([connectionId, source.schema, source.name, refresh]);
      let request = pending.get(key);
      if (!request) {
        const cached = columnCache.current.get(key);
        request = cached ? Promise.resolve(cached) : api.listColumns(connectionId, source.name, source.schema).then(columns => {
          if (current) columnCache.current.set(key, columns);
          return columns;
        });
        pending.set(key, request);
      }
      return [source.id, await request] as const;
    })).then(entries => { if (current) setMetadata({ key: metadataKey, columns: Object.fromEntries(entries), error: "" }); })
      .catch(error => { if (current) setMetadata({ key: metadataKey, columns: {}, error: String(error) }); });
    return () => { current = false; };
  }, [metadataKey]);

  const context: ExpressionContext = { sources: query.sources, columns: metadata.key === metadataKey ? metadata.columns : {} };
  const compiled = useMemo(() => {
    if (!connection || connection.driver === "redis") return { sql: "", error: new QueryBuilderError("connection") };
    try { return { sql: compileQuery(query, connection.driver), error: null }; }
    catch (error) { return { sql: "", error: error instanceof QueryBuilderError ? error : new QueryBuilderError("expression") }; }
  }, [query, connection]);
  const addTable = (entry: TreeEntry) => {
    let n = query.sources.length + 1;
    while (query.sources.some(source => source.alias.toLowerCase() === `t${n}`)) n += 1;
    const schema = entry.schema || draft.catalogSchema || (connection?.driver === "postgres" ? "public" : connection?.driver === "mysql" ? connection.database || undefined : undefined);
    changeQuery({ ...query, sources: [...query.sources, { id: crypto.randomUUID(), name: entry.name, schema, alias: `t${n}`, join: "INNER", on: emptyGroup() }] });
  };
  const refresh = () => { columnCache.current.clear(); setRevision(r => r + 1); };

  return <div className="flex h-full min-h-0 flex-col">
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/70 bg-surface/40 px-4 py-3">
      <Workflow className="h-5 w-5 shrink-0 text-brand" />
      <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">{t("builder.title")}</h2><p className="text-xs text-muted-foreground">{t("builder.description")}</p></div>
      <Button variant="primary" disabled={!compiled.sql} onClick={() => useWorkspace.getState().openTab({ id: `query:${crypto.randomUUID()}`, kind: "query", title: nextQueryTitle(), connectionId: draft.connectionId, sql: compiled.sql })}><ArrowUpRight className="h-3.5 w-3.5" />{t("builder.open_editor")}</Button>
    </header>
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto max-w-6xl space-y-4">
        <ToolCard title={t("builder.sources")}>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] items-start gap-3">
            <div><label className="mb-1 block text-xs text-muted-foreground" htmlFor={`${tab.id}-connection`}>{t("builder.connection")}</label>
              <ToolSelect id={`${tab.id}-connection`} value={draft.connectionId} onChange={e => query.sources.length ? setPendingConnection(e.target.value) : selectConnection(e.target.value)}>
                <option value="">{t("builder.choose_connection")}</option>
                {!connection && draft.connectionId && <option value={draft.connectionId}>{t("builder.missing_connection")}</option>}
                {connections.filter(c => c.driver !== "redis").map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </ToolSelect>
            </div>
            <SchemaPicker connectionId={draft.connectionId} value={draft.catalogSchema} onChange={catalogSchema => change({ ...draft, catalogSchema })} label={t("builder.schema")} />
            <div className="flex flex-wrap items-center gap-2 pt-4">
              {!connected && connection && <Button disabled={statuses[connection.id] === "connecting"} onClick={async () => {
                const generation = ++connectionGeneration.current;
                setConnectError("");
                try { await connect(connection.id); } catch (error) { if (generation === connectionGeneration.current) setConnectError(String(error)); }
              }}>{statuses[connection.id] === "connecting" ? t("common.loading") : t("common.connect")}</Button>}
              <Button disabled={!connected || (catalog.key === catalogKey && catalog.loading)} onClick={refresh}><RefreshCw className="h-3.5 w-3.5" />{t("common.refresh")}</Button>
            </div>
          </div>
          {connectError && <p role="alert" className="mt-2 break-words text-xs text-danger">{connectError}</p>}
          {catalog.key === catalogKey && catalog.error && <p role="alert" className="mt-2 break-words text-xs text-danger">{catalog.error}</p>}
          {metadata.key === metadataKey && metadata.error && <p role="alert" className="mt-2 break-words text-xs text-danger">{metadata.error}</p>}
          <div className="mt-3"><ToolSelect aria-label={t("builder.add_table")} value="" disabled={!connected || catalog.key !== catalogKey || catalog.loading} onChange={e => { const entry = catalog.entries[Number(e.target.value)]; if (e.target.value !== "" && entry) addTable(entry); }}>
            <option value="">{catalog.key === catalogKey && catalog.loading ? t("common.loading") : t("builder.add_table")}</option>
            {catalog.key === catalogKey && catalog.entries.map((entry, i) => <option key={`${entry.schema}:${entry.name}`} value={i}>{entry.schema ? `${entry.schema}.` : ""}{entry.name}</option>)}
          </ToolSelect></div>
          {connected && catalog.key === catalogKey && !catalog.loading && !catalog.error && catalog.entries.length === 0 && <p className="mt-2 text-xs text-muted-foreground">{t("builder.no_tables")}</p>}
          <div className="mt-3 space-y-3">{query.sources.map((source, index) => <div key={source.id} className="min-w-0 rounded-lg border border-border/70 bg-background/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium" title={`${source.schema ? `${source.schema}.` : ""}${source.name}`}>{source.schema ? `${source.schema}.` : ""}{source.name}</span>
              {index > 0 && <ToolSelect aria-label={`${t("builder.join")} ${index}`} value={source.join} onChange={e => changeQuery({ ...query, sources: query.sources.map(s => s.id === source.id ? { ...s, join: e.target.value as QuerySource["join"] } : s) })}>{["INNER", "LEFT", "RIGHT", "FULL", "CROSS"].map(join => <option key={join} disabled={join === "FULL" && connection?.driver === "mysql"}>{join}</option>)}</ToolSelect>}
              <input className={`${builderInput} w-24`} aria-label={`${t("builder.alias")} ${index + 1}`} value={source.alias} onChange={e => changeQuery({ ...query, sources: query.sources.map(s => s.id === source.id ? { ...s, alias: e.target.value } : s) })} />
              <RemoveButton label={`${t("builder.remove_table")} ${source.alias}`} onClick={() => changeQuery({ ...query, sources: query.sources.filter(s => s.id !== source.id) })} />
            </div>
            {index > 0 && source.join !== "CROSS" && <ConditionEditor value={source.on} onChange={on => changeQuery({ ...query, sources: query.sources.map(s => s.id === source.id ? { ...s, on } : s) })} context={{ ...context, sources: context.sources.slice(0, index + 1) }} label={`ON ${source.alias}`} />}
          </div>)}</div>
          {query.sources.length > 0 && <p className="mt-2 text-xs text-muted-foreground">{t("builder.remove_hint")}</p>}
        </ToolCard>

        {query.sources.length > 0 && <>
          <ToolCard title={t("builder.columns")} aside={<label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={query.distinct} onChange={e => changeQuery({ ...query, distinct: e.target.checked })} />DISTINCT</label>}>
            {!query.columns.length && <p className="mb-2 text-xs text-muted-foreground">{t("builder.all_columns")}</p>}
            <div className="space-y-2">{query.columns.map((column, index) => <div key={column.id} className="flex flex-wrap items-center gap-2">
              <ExpressionEditor value={column.expression} onChange={expression => changeQuery({ ...query, columns: query.columns.map(c => c.id === column.id ? { ...c, expression } : c) })} context={context} label={`${t("builder.column")} ${index + 1}`} />
              <input className={`${builderInput} w-28`} aria-label={`${t("builder.result_alias")} ${index + 1}`} placeholder={t("builder.alias")} value={column.alias} onChange={e => changeQuery({ ...query, columns: query.columns.map(c => c.id === column.id ? { ...c, alias: e.target.value } : c) })} />
              <RemoveButton label={`${t("builder.remove_column")} ${index + 1}`} onClick={() => changeQuery({ ...query, columns: query.columns.filter(c => c.id !== column.id) })} />
            </div>)}</div>
            <button className={`${smallButton} mt-2`} onClick={() => changeQuery({ ...query, columns: [...query.columns, { id: crypto.randomUUID(), expression: defaultColumn(context), alias: "" }] })}><Plus className="h-3 w-3" />{t("builder.add_column")}</button>
          </ToolCard>
          <ToolCard title="WHERE"><ConditionEditor value={query.where} onChange={where => changeQuery({ ...query, where })} context={context} label="WHERE" /></ToolCard>
          {(["groupBy", "orderBy"] as const).map(section => <ToolCard key={section} title={t(`builder.${section}`)}>
            <div className="space-y-2">{query[section].map((item, index) => <div key={item.id} className="flex flex-wrap items-center gap-2">
              <ExpressionEditor value={item.expression} onChange={expression => changeQuery({ ...query, [section]: query[section].map(c => c.id === item.id ? { ...c, expression } : c) })} context={context} label={`${t(`builder.${section}`)} ${index + 1}`} />
              {"direction" in item && <ToolSelect aria-label={`${t("builder.direction")} ${index + 1}`} value={item.direction} onChange={e => changeQuery({ ...query, orderBy: query.orderBy.map(c => c.id === item.id ? { ...c, direction: e.target.value as "ASC" | "DESC" } : c) })}><option>ASC</option><option>DESC</option></ToolSelect>}
              <RemoveButton label={`${t(`builder.${section}`)} · ${t("builder.remove_expression")} ${index + 1}`} onClick={() => changeQuery({ ...query, [section]: query[section].filter(c => c.id !== item.id) })} />
            </div>)}</div>
            <button className={`${smallButton} mt-2`} onClick={() => changeQuery({ ...query, [section]: [...query[section], { id: crypto.randomUUID(), expression: defaultColumn(context), ...(section === "orderBy" ? { direction: "ASC" } : {}) }] })}><Plus className="h-3 w-3" />{t("builder.add_expression")}</button>
          </ToolCard>)}
          <ToolCard title="HAVING"><ConditionEditor value={query.having} onChange={having => changeQuery({ ...query, having })} context={context} label="HAVING" /></ToolCard>
        </>}

        <ToolCard title={t("builder.preview")}>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">LIMIT<input className={`${builderInput} w-24`} value={query.limit} inputMode="numeric" placeholder="∞" onChange={e => changeQuery({ ...query, limit: e.target.value })} /></label>
            <label className="flex items-center gap-2 text-xs">OFFSET<input className={`${builderInput} w-24`} value={query.offset} inputMode="numeric" onChange={e => changeQuery({ ...query, offset: e.target.value })} /></label>
          </div>
          {compiled.error ? <p role="status" className="text-sm text-muted-foreground">{t(`builder.error.${compiled.error.code}`, { detail: compiled.error.detail })}</p>
            : <pre aria-label={t("builder.preview")} className="max-h-96 overflow-auto rounded-lg bg-background p-3 font-mono text-xs leading-6">{compiled.sql}</pre>}
          <p className="mt-2 text-xs text-muted-foreground">{t("builder.preview_hint")}</p>
        </ToolCard>
      </div>
    </div>
    <ConfirmDialog open={pendingConnection !== null} title={t("builder.change_connection")} message={t("builder.change_connection_hint")} confirmLabel={t("builder.change_connection")} cancelLabel={t("common.cancel")} onClose={() => setPendingConnection(null)} onConfirm={() => { if (pendingConnection !== null) selectConnection(pendingConnection); setPendingConnection(null); }} />
  </div>;
}
