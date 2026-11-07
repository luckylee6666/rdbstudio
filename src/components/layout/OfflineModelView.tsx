import { useEffect, useRef, useState } from "react";
import { FilePlus2, FolderOpen, Loader2, RefreshCw, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { MODEL_LIMITS, arrangeModelTables, modelFile, newModel, parseModel, parseModelFile, pushModelHistory, removeModelTable, type ModelDialect, type ModelRecord, type ModelRelation, type ModelSummary, type ModelTable, type OfflineModel } from "@/lib/offlineModel";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ModelCanvas } from "@/components/models/ModelCanvas";
import { modelControl, modelError, RelationModelEditor, TableModelEditor } from "@/components/models/ModelEditors";
import { saveTextFile } from "@/lib/csv";
import { useT } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import type { WorkspaceTab } from "@/types";
import { cn } from "@/lib/cn";
import { ModelReverseDialog } from "@/components/models/ModelReverseDialog";
import { ModelDdlDialog } from "@/components/models/ModelDdlDialog";

type Naming = { kind: "create" | "copy" | "rename"; model: OfflineModel };
export function OfflineModelView({ tab }: { tab: WorkspaceTab }) {
  const t = useT(), active = useWorkspace(s => s.activeTabId === tab.id);
  const [list, setList] = useState<ModelSummary[]>([]), [search, setSearch] = useState("");
  const [record, setRecord] = useState<ModelRecord | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null), [tableEdit, setTableEdit] = useState<ModelTable | null>(null), [relationEdit, setRelationEdit] = useState<ModelRelation | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null), [name, setName] = useState(""), [confirm, setConfirm] = useState<"delete" | "reload" | "table" | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [reversing, setReversing] = useState(false);
  const [ddlRecord, setDdlRecord] = useState<ModelRecord | null>(null);
  const [past, setPast] = useState<OfflineModel[]>([]), [future, setFuture] = useState<OfflineModel[]>([]);
  const fileInput = useRef<HTMLInputElement>(null), alive = useRef(true), locked = useRef(false), current = useRef<ModelRecord | null>(null), loadGeneration = useRef(0);
  const adopt = (value: ModelRecord | null) => { current.current = value; setRecord(value); useWorkspace.setState(s => ({ tabs: s.tabs.map(item => item.id === tab.id ? { ...item, modelId: value?.id } : item) })); };
  const refresh = async () => { const generation = ++loadGeneration.current; const items = await api.listOfflineModels(); if (alive.current && generation === loadGeneration.current) setList(items); };
  const perform = async (action: () => Promise<void>) => {
    if (locked.current) return false;
    locked.current = true; setBusy(true); setError(null);
    try { await action(); return true; } catch (cause) { if (alive.current) setError(modelError(cause, t)); return false; }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true; let cancelled = false;
    locked.current = true; setBusy(true);
    void (async () => {
      await refresh();
      if (cancelled || !alive.current) return;
      if (tab.modelId) { const saved = await api.getOfflineModel(tab.modelId); if (!cancelled && alive.current) adopt({ ...saved, model: parseModel(saved.model) }); }
    })().catch(cause => { if (!cancelled && alive.current) setError(modelError(cause, t)); }).finally(() => { if (!cancelled && alive.current) { locked.current = false; setBusy(false); } });
    return () => { cancelled = true; alive.current = false; loadGeneration.current++; };
    // Keep the editor and undo history alive across workspace tab switches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const upsertSummary = (saved: ModelRecord) => { const summary = { id: saved.id, revision: saved.revision, name: saved.name, updated_at: saved.updated_at, dialect: saved.model.dialect, tables: saved.model.tables.length, relations: saved.model.relations.length }; setList(items => [summary, ...items.filter(item => item.id !== saved.id)]); };
  const commit = (model: OfflineModel, history: "push" | "undo" | "redo" = "push") => perform(async () => {
    const original = current.current; if (!original) return;
    const next = parseModel(model);
    const saved = await api.saveOfflineModel({ id: original.id, revision: original.revision, name: original.name, model: next });
    if (!alive.current) return;
    if (history === "push") { setPast(previous => pushModelHistory(previous, original.model)); setFuture([]); }
    else if (history === "undo") { setPast(previous => previous.slice(0, -1)); setFuture(previous => pushModelHistory(previous, original.model)); }
    else { setFuture(previous => previous.slice(0, -1)); setPast(previous => pushModelHistory(previous, original.model)); }
    adopt(saved); upsertSummary(saved);
  });
  const choose = (id: string) => { if (current.current?.id === id) return; void perform(async () => { const saved = await api.getOfflineModel(id); if (alive.current) { adopt({ ...saved, model: parseModel(saved.model) }); setSelected(null); setPast([]); setFuture([]); } }); };
  const create = () => { setError(null); setName(""); setNaming({ kind: "create", model: newModel() }); };
  const saveNamed = () => void perform(async () => {
    if (!naming) return;
    const saved = naming.kind === "rename" && current.current ? await api.renameOfflineModel(current.current.id, current.current.revision, name) : await api.saveOfflineModel({ id: null, revision: null, name, model: naming.model });
    if (alive.current) { adopt(saved); upsertSummary(saved); setNaming(null); setPast([]); setFuture([]); setSelected(null); }
  });
  const addTable = () => {
    if (!record) return; let n = record.model.tables.length + 1;
    while (record.model.tables.some(table => table.name.toLowerCase() === `table_${n}`)) n++;
    setError(null); setTableEdit({ id: crypto.randomUUID(), name: `table_${n}`, schema: "", comment: "", position: { x: (record.model.tables.length % 4) * 300, y: Math.floor(record.model.tables.length / 4) * 300 }, columns: [] });
  };
  const addRelation = () => {
    if (!record?.model.tables.length) return;
    const from = record.model.tables.find(table => table.id === selected) ?? record.model.tables[0], to = record.model.tables.find(table => table.id !== from.id) ?? from;
    let n = record.model.relations.length + 1; while (record.model.relations.some(r => r.fromTable === from.id && r.name.toLowerCase() === `relationship_${n}`)) n++;
    setError(null); setRelationEdit({ id: crypto.randomUUID(), name: `relationship_${n}`, fromTable: from.id, toTable: to.id, fromColumns: [from.columns[0]?.id ?? ""], toColumns: [to.columns.find(c => c.primaryKey)?.id ?? to.columns[0]?.id ?? ""], cardinality: "one-many", identifying: false });
  };
  const selectedTable = record?.model.tables.find(table => table.id === selected), selectedRelation = record?.model.relations.find(r => r.id === selected);
  const confirmAction = async () => {
    if (!record) return;
    if (confirm === "table" && selectedTable) { if (await commit(removeModelTable(record.model, selectedTable.id))) { setConfirm(null); setSelected(null); } return; }
    await perform(async () => {
      if (confirm === "delete") { await api.deleteOfflineModel(record.id, record.revision); if (alive.current) { setList(items => items.filter(item => item.id !== record.id)); adopt(null); } }
      else { const saved = await api.getOfflineModel(record.id); if (alive.current) { adopt({ ...saved, model: parseModel(saved.model) }); upsertSummary(saved); setLayoutVersion(v => v + 1); } }
      if (alive.current) { setPast([]); setFuture([]); setSelected(null); setConfirm(null); }
    });
  };
  return <div className="flex h-full min-w-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <Workflow className="h-4 w-4 text-brand" /><h2 className="text-sm font-semibold">{t("model.title")}</h2>
      <Button size="sm" disabled={busy} onClick={create}><FilePlus2 className="mr-1 h-3.5 w-3.5" />{t("model.new")}</Button>
      <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}><FolderOpen className="mr-1 h-3.5 w-3.5" />{t("model.import")}</Button>
      <Button size="sm" disabled={busy} onClick={() => { setError(null); setReversing(true); }}>{t("model.reverse.title")}</Button>
      <Button size="sm" disabled={busy} aria-label={t("common.refresh")} onClick={() => void perform(refresh)}><RefreshCw className="h-3.5 w-3.5" /></Button>
      <span role="status" className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">{busy ? <><Loader2 className="h-3 w-3 animate-spin" />{t("model.saving")}</> : record ? t("model.saved") : ""}</span>
      <input ref={fileInput} type="file" accept=".json" className="hidden" aria-label={t("model.import")} onChange={e => { const file = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (!file) return; void perform(async () => { if (file.size > MODEL_LIMITS.bytes) throw new Error("model_size"); const imported = parseModelFile(await file.text()); if (alive.current) { setName(imported.name); setNaming({ kind: "create", model: imported.model }); } }); }} />
    </div>
    {error && <p role="alert" className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p>}
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-48 max-w-[30%] shrink-0 flex-col border-r border-border bg-surface/30 p-2">
        <input className={modelControl} aria-label={t("model.search")} placeholder={t("model.search")} value={search} onChange={e => setSearch(e.target.value)} />
        <div className="mt-2 flex-1 space-y-1 overflow-auto">{list.filter(item => item.name.toLowerCase().includes(search.toLowerCase())).map(item => <button key={item.id} disabled={busy} onClick={() => choose(item.id)} title={item.name} aria-pressed={record?.id === item.id} className={cn("w-full rounded-md px-2 py-2 text-left text-sm hover:bg-accent disabled:opacity-50", record?.id === item.id && "bg-accent")}><span className="block truncate font-medium">{item.name}</span><span className="text-[10px] text-muted-foreground">{item.dialect.toUpperCase()} · {item.tables} {t("model.tables")}</span></button>)}</div>
      </aside>
      {!record ? <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center"><Workflow className="h-10 w-10 text-brand/60" /><p className="text-sm">{t("model.empty")}</p><p className="max-w-sm text-xs text-muted-foreground">{t("model.help")}</p><Button disabled={busy} onClick={create}>{t("model.create")}</Button></div> : <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-2">
          <p className="min-w-0 basis-full truncate text-sm font-semibold" title={record.name}>{record.name} <span className="text-[10px] font-normal text-muted-foreground">{record.model.dialect.toUpperCase()}</span></p>
          <Button size="sm" disabled={busy || record.model.tables.length >= MODEL_LIMITS.tables} onClick={addTable}>{t("model.add_table")}</Button>
          <Button size="sm" disabled={busy || !record.model.tables.length || record.model.relations.length >= MODEL_LIMITS.relations} onClick={addRelation}>{t("model.add_relation")}</Button>
          <Button size="sm" disabled={busy || !past.length} onClick={() => void commit(past[past.length - 1], "undo")}>{t("model.undo")}</Button>
          <Button size="sm" disabled={busy || !future.length} onClick={() => void commit(future[future.length - 1], "redo")}>{t("model.redo")}</Button>
          <Button size="sm" disabled={busy || !record.model.tables.length} onClick={() => void commit(arrangeModelTables(record.model)).then(saved => { if (saved && alive.current) setLayoutVersion(v => v + 1); })}>{t("model.layout")}</Button>
          <Button size="sm" disabled={busy} onClick={() => { setName(record.name); setNaming({ kind: "copy", model: record.model }); }}>{t("model.copy")}</Button>
          <Button size="sm" disabled={busy} onClick={() => { setName(record.name); setNaming({ kind: "rename", model: record.model }); }}>{t("model.rename")}</Button>
          <Button size="sm" disabled={busy} onClick={() => void perform(async () => { await saveTextFile(`${record.name}.rdbmodel.json`, modelFile(record.name, record.model), "json"); })}>{t("model.export")}</Button>
          <Button size="sm" disabled={busy} onClick={() => setDdlRecord(record)}>{t("model.ddl.title")}</Button>
          <Button size="sm" disabled={busy} onClick={() => setConfirm("reload")}>{t("model.reload")}</Button>
          <Button size="sm" disabled={busy} onClick={() => setConfirm("delete")}>{t("model.delete")}</Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
          <select className={`${modelControl} !w-auto max-w-[50%]`} aria-label={t("model.tables")} value={selectedTable?.id ?? ""} disabled={busy} onChange={e => setSelected(e.target.value || null)}><option value="">{t("model.tables")} ({record.model.tables.length})</option>{record.model.tables.map(table => <option key={table.id} value={table.id}>{table.schema ? table.schema + "." : ""}{table.name}</option>)}</select>
          <select className={`${modelControl} !w-auto max-w-[50%]`} aria-label={t("model.relations")} value={selectedRelation?.id ?? ""} disabled={busy} onChange={e => setSelected(e.target.value || null)}><option value="">{t("model.relations")} ({record.model.relations.length})</option>{record.model.relations.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          {selectedTable && <><Button size="sm" disabled={busy} onClick={() => { setError(null); setTableEdit(selectedTable); }}>{t("model.edit_table")}</Button><Button size="sm" disabled={busy} onClick={() => setConfirm("table")}>{t("model.remove_table")}</Button></>}
          {selectedRelation && <><Button size="sm" disabled={busy} onClick={() => { setError(null); setRelationEdit(selectedRelation); }}>{t("model.edit_relation")}</Button><Button size="sm" disabled={busy} onClick={() => void commit({ ...record.model, relations: record.model.relations.filter(r => r.id !== selectedRelation.id) })}>{t("model.remove_relation")}</Button></>}
        </div>
        <ModelCanvas layoutVersion={layoutVersion} key={record.id} model={record.model} busy={busy} active={active} selected={selected} onSelect={setSelected} onEdit={id => { if (!busy) { setError(null); setTableEdit(record.model.tables.find(table => table.id === id) ?? null); } }} onMove={(id, position) => commit({ ...record.model, tables: record.model.tables.map(table => table.id === id ? { ...table, position } : table) })} />
        <p className="border-t border-border px-3 py-1.5 text-[10px] text-muted-foreground">{t("model.select")}</p>
      </div>}
    </div>
    {tableEdit && record && <TableModelEditor model={record.model} initial={tableEdit} busy={busy} visible={active} saveError={error} onSave={commit} onClose={() => setTableEdit(null)} />}
    {relationEdit && record && <RelationModelEditor model={record.model} initial={relationEdit} busy={busy} visible={active} saveError={error} onSave={commit} onClose={() => setRelationEdit(null)} />}
    {reversing && <ModelReverseDialog visible={active} busy={busy} saveError={error} onClose={() => setReversing(false)} onSave={(name, model) => perform(async () => {
      const saved = await api.saveOfflineModel({ id: null, revision: null, name, model });
      if (alive.current) { adopt(saved); upsertSummary(saved); setPast([]); setFuture([]); setSelected(null); }
    })} />}
    {ddlRecord && <ModelDdlDialog record={ddlRecord} visible={active} onClose={() => setDdlRecord(null)} />}
    <Modal open={active && !!naming} closeDisabled={busy} title={t(naming?.kind === "rename" ? "model.rename" : naming?.kind === "copy" ? "model.copy" : "model.create")} onClose={() => { if (!busy) setNaming(null); }} width={460}>
      <label className="block text-xs">{t("model.name")}<input autoFocus disabled={busy} className={modelControl} aria-label={t("model.name")} value={name} maxLength={100} onChange={e => setName(e.target.value)} /></label>
      {naming?.kind === "create" && !naming.model.tables.length && <label className="mt-3 block text-xs">{t("model.dialect")}<select className={modelControl} aria-label={t("model.dialect")} disabled={busy} value={naming.model.dialect} onChange={e => setNaming({ ...naming, model: { ...naming.model, dialect: e.target.value as ModelDialect } })}>{["sqlite", "postgres", "mysql"].map(d => <option key={d} value={d}>{d.toUpperCase()}</option>)}</select></label>}
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button disabled={busy} onClick={() => setNaming(null)}>{t("common.cancel")}</Button><Button disabled={busy || !name.trim()} onClick={saveNamed}>{t("common.save")}</Button></div>
    </Modal>
    <Modal open={active && !!confirm} closeDisabled={busy} title={t(confirm === "delete" ? "model.delete" : confirm === "table" ? "model.remove_table" : "model.reload")} onClose={() => { if (!busy) setConfirm(null); }} width={440}>
      <p className="text-sm">{t(confirm === "delete" ? "model.delete_hint" : confirm === "table" ? "model.remove_table_hint" : "model.reload_hint")}</p>
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2"><Button disabled={busy} onClick={() => setConfirm(null)}>{t("common.cancel")}</Button><Button disabled={busy} variant={confirm === "reload" ? "primary" : "danger"} onClick={() => void confirmAction()}>{t(confirm === "delete" ? "model.delete" : confirm === "table" ? "model.remove_table" : "model.reload")}</Button></div>
    </Modal>
  </div>;
}
