import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ArrowUpRight, Loader2, Search, Table2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { cn } from "@/lib/cn";
import {
  ConnectionPicker,
  SchemaPicker,
  ToolCard,
  ToolPage,
  useDefaultConnection,
} from "@/components/tools/ToolKit";
import { syncApi } from "@/lib/sync-api";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import type { ConnectionConfig, Filter, TreeEntry } from "@/types";
import type { SearchHit, SearchResult } from "@/types/sync";

const acceptSql = (c: ConnectionConfig) => c.driver !== "redis";
import { syncText } from "./syncI18n";

export function GlobalSearchView() {
  const connections = useConnections((s) => s.list);
  const statuses = useConnections((s) => s.status);
  const lang = useI18n((s) => s.lang);
  const openTab = useWorkspace((s) => s.openTab);
  const t = (key: Parameters<typeof syncText>[1]) => syncText(lang, key);
  const sqlConnections = useMemo(() => connections.filter((c) => c.driver !== "redis"), [connections]);
  const [connectionId, setConnectionId] = useState("");
  const [schema, setSchema] = useState("");
  const [text, setText] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [tables, setTables] = useState<TreeEntry[]>([]);
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const defaultId = useDefaultConnection(acceptSql);
  useEffect(() => {
    if (!connectionId && defaultId) setConnectionId(defaultId);
  }, [connectionId, defaultId]);

  useEffect(() => {
    let cancelled = false;
    if (!connectionId || statuses[connectionId] !== "connected") {
      setTables([]);
      setSelectedTables([]);
      return;
    }
    void invoke<TreeEntry[]>("list_tables", { id: connectionId, schema: schema || null })
      .then((entries) => {
        if (cancelled) return;
        const next = entries.filter((entry) => entry.kind === "table");
        setTables(next);
        setSelectedTables((selected) => selected.filter((name) => next.some((entry) => entry.name === name)));
      })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [connectionId, schema, statuses]);

  async function search() {
    if (!text.trim() || !connectionId) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const next = await syncApi.search({
        connection_id: connectionId,
        schema: schema || null,
        tables: selectedTables,
        text,
        case_sensitive: caseSensitive,
        limit: 100,
      });
      setResult(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function openHit(hit: SearchHit) {
    const driver = sqlConnections.find((c) => c.id === connectionId)?.driver;
    const schemaValue = hit.schema ?? (schema || (driver === "postgres" ? "public" : undefined));
    const filters: Filter[] = hit.primary_key.map(([column, value]) => ({
      column,
      op: "eq",
      value: value === null || value === undefined ? undefined : String(value),
    }));
    const pkLabel = hit.primary_key.map(([c, v]) => `${c}=${String(v)}`).join(",");
    openTab({
      id: `data:${connectionId}:${schemaValue ?? ""}:${hit.table}:search:${pkLabel}`,
      kind: "table-data",
      title: hit.table,
      subtitle: pkLabel || "Data",
      connectionId,
      schema: schemaValue,
      table: hit.table,
      initialFilters: filters.length > 0 ? filters : undefined,
    });
  }

  const isConnected = statuses[connectionId] === "connected";
  const allSelected = tables.length > 0 && selectedTables.length === tables.length;
  return (
    <ToolPage icon={Search} title={t("searchTitle")} description={t("searchDesc")}>
      <div className="mx-auto max-w-5xl space-y-4">
        <ToolCard>
          <div className="grid gap-3 md:grid-cols-2">
            <ConnectionPicker
              label={t("connection")}
              value={connectionId}
              accept={acceptSql}
              onChange={(id) => { setConnectionId(id); setSchema(""); setResult(null); }}
            />
            <SchemaPicker
              label={t("schema")}
              connectionId={connectionId}
              value={schema}
              onChange={(v) => { setSchema(v); setResult(null); }}
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <div className="relative min-w-[260px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={t("searchText")}
                placeholder={t("searchPlaceholder")}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void search(); }}
                className="pl-8"
              />
            </div>
            <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} />{t("caseSensitive")}
            </label>
            <Button variant="primary" disabled={!isConnected || !text.trim() || busy} onClick={() => void search()}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}{t("search")}
            </Button>
          </div>
        </ToolCard>

        <ToolCard
          title={`${t("tables")}${selectedTables.length ? ` · ${selectedTables.length}/${tables.length}` : ""}`}
          aside={
            <Button size="sm" variant="ghost" disabled={tables.length === 0} onClick={() => setSelectedTables(allSelected ? [] : tables.map((x) => x.name))}>
              {allSelected ? t("selectNone") : t("allTables")}
            </Button>
          }
        >
          {tables.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">—</p>
          ) : (
            <div className="flex max-h-36 flex-wrap gap-1.5 overflow-auto">
              {tables.map((entry) => {
                const on = selectedTables.includes(entry.name);
                return (
                  <button
                    key={entry.name}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setSelectedTables((current) => (on ? current.filter((name) => name !== entry.name) : [...current, entry.name]))}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11.5px] transition-colors",
                      on ? "border-brand/60 bg-brand/15 text-brand" : "border-border/70 text-muted-foreground hover:border-border hover:text-foreground"
                    )}
                  >
                    <Table2 className="h-3 w-3" />
                    {entry.name}
                  </button>
                );
              })}
            </div>
          )}
        </ToolCard>

        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="break-all">{error}</span>
          </div>
        )}

        {result && (
          <ToolCard
            title={`${t("result")} · ${result.hits.length} / ${result.tables_searched}`}
            aside={result.truncated ? <span role="status" className="text-[11.5px] text-warning">{t("truncated")}</span> : undefined}
          >
            {result.hits.length === 0 ? (
              <p className="text-[12px] text-muted-foreground">{t("noResults")}</p>
            ) : (
              <div className="max-h-[50vh] overflow-auto rounded-lg border border-border/60">
                <table className="w-full text-left text-[12px]">
                  <thead className="sticky top-0 bg-surface-elevated text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-2.5 py-2 font-medium">{t("openTable")}</th>
                      <th className="px-2.5 py-2 font-medium">{t("column")}</th>
                      <th className="px-2.5 py-2 font-medium">{t("primaryKey")}</th>
                      <th className="px-2.5 py-2 font-medium">{t("value")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.hits.map((hit, index) => (
                      <tr key={`${hit.table}:${hit.column}:${index}`} className="border-t border-border/50 hover:bg-accent/40">
                        <td className="px-2.5 py-1.5">
                          <button title={t("opensRow")} className="flex items-center gap-1 font-mono text-brand hover:underline" onClick={() => openHit(hit)}>
                            {hit.table}
                            <ArrowUpRight className="h-3 w-3" />
                          </button>
                        </td>
                        <td className="px-2.5 py-1.5 font-mono">{hit.column}</td>
                        <td className="max-w-[240px] truncate px-2.5 py-1.5 font-mono text-muted-foreground" title={JSON.stringify(hit.primary_key)}>
                          {hit.primary_key.map(([c, v]) => `${c}=${String(v)}`).join(", ")}
                        </td>
                        <td className="max-w-[420px] truncate px-2.5 py-1.5 font-mono" title={String(hit.value)}>{String(hit.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ToolCard>
        )}
      </div>
    </ToolPage>
  );
}
