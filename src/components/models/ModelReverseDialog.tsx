import { useEffect, useMemo, useRef, useState } from "react";
import { Database, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { MODEL_LIMITS, arrangeModelTables, modelPrimaryKey, parseModel, type OfflineModel } from "@/lib/offlineModel";
import { reverseError, sourceKey, type ModelReversePreview, type ModelSourceTable } from "@/lib/modelReverse";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { modelControl } from "./ModelEditors";

export function ModelReverseDialog({ visible, busy, saveError, onSave, onClose }: { visible: boolean; busy: boolean; saveError: string | null; onSave: (name: string, model: OfflineModel) => Promise<boolean>; onClose: () => void }) {
  const t = useT(), connections = useConnections(s => s.list), statuses = useConnections(s => s.status);
  const targets = connections.filter(c => c.driver !== "redis" && statuses[c.id] === "connected");
  const [connectionId, setConnectionId] = useState(""), [schemas, setSchemas] = useState<string[]>([]), [schema, setSchema] = useState("");
  const [tables, setTables] = useState<ModelSourceTable[]>([]), [selected, setSelected] = useState<ModelSourceTable[]>([]), [search, setSearch] = useState("");
  const [catalogLoading, setCatalogLoading] = useState(false), [tablesLoading, setTablesLoading] = useState(false), [readingPreview, setReadingPreview] = useState(false);
  const loading = readingPreview ? "preview" : catalogLoading ? "schemas" : tablesLoading ? "tables" : null;
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ModelReversePreview | null>(null), [name, setName] = useState(""), [accepted, setAccepted] = useState(false);
  const generation = useRef(0), alive = useRef(true), reading = useRef(false);
  const connection = targets.find(c => c.id === connectionId);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  useEffect(() => {
    ++generation.current; reading.current = false; let cancelled = false;
    setPreview(null); setAccepted(false); setSchemas([]); setSchema(""); setTables([]); setSelected([]); setError(null); setReadingPreview(false); setCatalogLoading(false);
    if (!connection) return () => { cancelled = true; };
    setCatalogLoading(true);
    void api.listDatabases(connection.id).then(items => { if (alive.current && !cancelled) { setSchemas(items); setSchema(items[0] ?? ""); setName(connection.name.slice(0, 100)); } })
      .catch(cause => { if (alive.current && !cancelled) setError(t(`model.reverse.error.${reverseError(cause)}`)); })
      .finally(() => { if (alive.current && !cancelled) setCatalogLoading(false); });
    return () => { cancelled = true; };
  }, [connection]);
  useEffect(() => {
    let cancelled = false; setTables([]); setTablesLoading(false);
    if (!connection || !schema) return () => { cancelled = true; };
    setTablesLoading(true);
    void api.listTables(connection.id, connection.driver === "sqlite" ? undefined : schema).then(items => { if (alive.current && !cancelled) setTables(items.filter(e => e.kind === "table").map(e => ({ name: e.name, schema }))); })
      .catch(cause => { if (alive.current && !cancelled) setError(t(`model.reverse.error.${reverseError(cause)}`)); })
      .finally(() => { if (alive.current && !cancelled) setTablesLoading(false); });
    return () => { cancelled = true; };
  }, [connection, schema]);
  const matching = useMemo(() => tables.filter(table => table.name.toLowerCase().includes(search.toLowerCase())), [tables, search]);
  const selectedKeys = new Set(selected.map(sourceKey));
  const updateSelection = (next: ModelSourceTable[]) => { generation.current++; reading.current = false; setReadingPreview(false); setSelected(next); setPreview(null); setAccepted(false); setError(null); };
  const read = async () => {
    if (reading.current || !connection || !selected.length) return;
    reading.current = true; const run = ++generation.current; setReadingPreview(true); setPreview(null); setAccepted(false); setError(null);
    try {
      const value = await api.previewReverseModel(connection.id, selected);
      const model = arrangeModelTables(parseModel(value.model));
      if (model.dialect !== connection.driver || model.tables.length !== selected.length || model.tables.some(table => !selectedKeys.has(sourceKey(table)))) throw new Error("model_reverse_changed");
      if (alive.current && run === generation.current) setPreview({ ...value, model });
    } catch (cause) { if (alive.current && run === generation.current) setError(t(`model.reverse.error.${reverseError(cause)}`)); }
    finally { if (alive.current && run === generation.current) { reading.current = false; setReadingPreview(false); } }
  };
  const saving = async () => { if (!preview || !accepted || !connection || busy) return; if (await onSave(name, preview.model)) onClose(); };
  const remaining = matching.filter(table => !selectedKeys.has(sourceKey(table)));
  return <Modal open={visible} title={t("model.reverse.title")} width={960} closeDisabled={busy} onClose={onClose} footer={<>
    <Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
    <Button disabled={busy || !!loading || !connection || !selected.length} onClick={() => void read()}>{t("model.reverse.preview")}</Button>
    <Button disabled={busy || !preview || !accepted || !name.trim() || !connection} onClick={() => void saving()}>{t("model.reverse.save")}</Button>
  </>}>
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("model.reverse.help")}</p>
      <fieldset disabled={busy || loading === "preview"} className="grid grid-cols-2 gap-3">
        <label className="min-w-0 text-xs">{t("model.reverse.source")}<select aria-label={t("model.reverse.source")} className={modelControl} value={connection?.id ?? ""} onChange={e => setConnectionId(e.target.value)}><option value="">{t("model.reverse.choose")}</option>{targets.map(c => <option key={c.id} value={c.id}>{c.name} · {c.driver.toUpperCase()}</option>)}</select></label>
        <label className="min-w-0 text-xs">{t("model.schema")}<select aria-label={t("model.reverse.schema")} className={modelControl} value={schema} disabled={busy || !!loading} onChange={e => { setSchema(e.target.value); setSearch(""); setError(null); }}><option value="">—</option>{schemas.map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2"><input className={`${modelControl} flex-1`} aria-label={t("model.reverse.search")} placeholder={t("model.reverse.search")} value={search} onChange={e => setSearch(e.target.value)} disabled={busy || loading === "preview"} /><Button size="sm" disabled={busy || !!loading || !remaining.length || selected.length + remaining.length > MODEL_LIMITS.tables} onClick={() => updateSelection([...selected, ...remaining])}>{t("model.reverse.select_matching")}</Button><Button size="sm" disabled={busy || !!loading || !selected.length} onClick={() => updateSelection([])}>{t("model.reverse.clear")}</Button></div>
      <p className="text-xs text-muted-foreground">{t("model.reverse.selection")} {selected.length}/{MODEL_LIMITS.tables} · {t("model.reverse.matches")} {matching.length}</p>
      <div className="max-h-40 min-h-20 overflow-auto rounded-md border border-border p-2">
        {matching.slice(0, 500).map(table => { const key = sourceKey(table), checked = selectedKeys.has(key); return <label key={key} className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent"><input type="checkbox" aria-label={`${table.schema}.${table.name}`} checked={checked} disabled={busy || !!loading || !checked && selected.length >= MODEL_LIMITS.tables} onChange={e => updateSelection(e.target.checked ? [...selected, table] : selected.filter(t => sourceKey(t) !== key))} /><Database className="h-3 w-3 shrink-0 text-muted-foreground" /><span className="min-w-0 break-all">{table.name}</span></label>; })}
        {!matching.length && !loading && <p className="p-2 text-xs text-muted-foreground">{t("model.reverse.empty")}</p>}
      </div>
      {matching.length > 500 && <p className="text-xs text-muted-foreground">{t("model.reverse.filter_more")}</p>}
      {selected.some(table => table.schema !== schema) && <details className="text-xs"><summary className="cursor-pointer">{t("model.reverse.other_schemas")}</summary><div className="mt-1 max-h-24 overflow-auto space-y-1">{selected.filter(table => table.schema !== schema).map(table => <label key={sourceKey(table)} className="flex gap-2 break-all"><input type="checkbox" checked disabled={busy || !!loading} onChange={() => updateSelection(selected.filter(t => sourceKey(t) !== sourceKey(table)))} />{table.schema}.{table.name}</label>)}</div></details>}
      {loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t(`model.reverse.loading.${loading}`)}</p>}
      {(error || saveError) && <p role="alert" className="text-xs text-danger">{error || saveError}</p>}
      {preview && <section className="space-y-3 rounded-md border border-border p-3" aria-label={t("model.reverse.result")}>
        <p className="text-sm font-medium">{preview.model.tables.length} {t("model.tables")} · {preview.model.tables.reduce((n, t) => n + t.columns.length, 0)} {t("model.fields")} · {preview.model.relations.length} {t("model.relations")}</p>
        <div className="max-h-32 space-y-1 overflow-auto text-xs">{preview.model.tables.map(table => <p key={table.id} className="break-all"><span className="font-medium">{table.schema}.{table.name}</span> · {table.columns.length} {t("model.fields")} · PK ({modelPrimaryKey(table).map(id => table.columns.find(c => c.id === id)?.name).join(", ") || "—"}) · UQ {table.uniqueKeys?.length ?? 0}</p>)}</div>
        <details open className="text-xs"><summary className="cursor-pointer font-medium">{t("model.reverse.notes")} ({preview.warnings.length + preview.omitted_warnings})</summary><ul className="mt-2 max-h-40 list-disc space-y-1 overflow-auto pl-5 text-muted-foreground">{preview.warnings.map((warning, i) => <li key={i} className="break-words">{t(`model.reverse.warning.${warning.code}`)}{warning.object && ` · ${warning.object}`}</li>)}</ul>{preview.omitted_warnings > 0 && <p>{t("model.reverse.more_notes")} {preview.omitted_warnings}</p>}</details>
        <label className="block text-xs">{t("model.name")}<input className={modelControl} aria-label={t("model.name")} maxLength={100} value={name} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)} />{t("model.reverse.accept")}</label>
      </section>}
    </div>
  </Modal>;
}
