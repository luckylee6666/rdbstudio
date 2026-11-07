import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/store/i18n";
import { MODEL_ACTIONS, MODEL_LIMITS, modelPrimaryKey, parseModel, replaceModelTable, type ModelTable, type ModelRelation, type OfflineModel } from "@/lib/offlineModel";
import { ModelKeysEditor } from "./ModelKeysEditor";
export const modelControl = "w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm";
export function modelError(cause: unknown, t: (key: string) => string) {
  const message = String(cause).replace(/^Error: /, "");
  if (message === "preset_size") return t("model.error.library_size");
  const code = message.replace(/^(model|preset)_/, "");
  return t(`model.error.${["invalid","version","limit","size","duplicate","primary","reference","conflict","name","not_found","corrupt","storage"].includes(code) ? code : "storage"}`);
}
export function TableModelEditor({ model, initial, busy, visible, saveError, onSave, onClose }: { model: OfflineModel; initial: ModelTable; busy: boolean; visible: boolean; saveError?: string | null; onSave: (next: OfflineModel) => Promise<boolean>; onClose: () => void }) {
  const t = useT(), [table, setTable] = useState(initial), [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<"fields" | "keys">("fields");
  const column = (id: string, change: Partial<ModelTable["columns"][number]>) => setTable(current => ({ ...current, ...(change.primaryKey !== undefined ? { primaryKey: change.primaryKey ? [...modelPrimaryKey(current).filter(v => v !== id), id] : modelPrimaryKey(current).filter(v => v !== id) } : {}), columns: current.columns.map(c => c.id === id ? { ...c, ...change } : c) }));
  const move = (index: number, step: number) => setTable(current => { const columns = [...current.columns]; [columns[index], columns[index + step]] = [columns[index + step], columns[index]]; return { ...current, primaryKey: modelPrimaryKey(current), columns }; });
  const apply = async () => { setError(null); try { const next = replaceModelTable({ ...model, version: 2 }, table); if (await onSave(next)) onClose(); } catch (cause) { setError(modelError(cause, t)); } };
  return <Modal open={visible} closeDisabled={busy} title={t("model.edit_table")} onClose={() => { if (!busy) onClose(); }} width={920} footer={<><Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button disabled={busy} onClick={() => void apply()}>{t("model.apply")}</Button></>}>
    <div className="flex min-h-0 flex-col gap-3">
      <fieldset disabled={busy} className="grid grid-cols-2 gap-3">
        <label className="text-xs">{t("model.table_name")}<input className={modelControl} aria-label={t("model.table_name")} value={table.name} maxLength={128} onChange={e => setTable({ ...table, name: e.target.value })} /></label>
        <label className="text-xs">{t("model.schema")}<input className={modelControl} aria-label={t("model.schema")} value={table.schema} maxLength={128} onChange={e => setTable({ ...table, schema: e.target.value })} /></label>
        <label className="col-span-2 text-xs">{t("model.comment")}<textarea className={modelControl} aria-label={t("model.comment")} rows={2} maxLength={4096} value={table.comment} onChange={e => setTable({ ...table, comment: e.target.value })} /></label>
      </fieldset>
      <div role="group" aria-label={t("model.keys.sections")} className="flex gap-1 border-b border-border">{(["fields", "keys"] as const).map(item => <button type="button" aria-pressed={section === item} key={item} className={`px-3 py-2 text-xs font-medium ${section === item ? "border-b-2 border-brand text-brand" : "text-muted-foreground"}`} onClick={() => setSection(item)}>{t(item === "fields" ? "model.fields" : "model.keys.title")}</button>)}</div>
      {section === "fields" ? <><div className="flex items-center justify-between text-sm"><span>{t("model.fields")} · {table.columns.length}</span><Button size="sm" disabled={busy || table.columns.length >= MODEL_LIMITS.columns} onClick={() => setTable({ ...table, columns: [...table.columns, { id: crypto.randomUUID(), name: `field_${table.columns.length + 1}`, type: "TEXT", nullable: true, primaryKey: false, unique: false, comment: "" }] })}>{t("model.add_field")}</Button></div>
      <div className="max-h-[38vh] space-y-2 overflow-y-auto rounded-md border border-border p-2">
        {table.columns.map((c, i) => <fieldset key={c.id} disabled={busy} className="rounded-md bg-surface-muted/50 p-2" aria-label={`${t("model.fields")} ${i + 1}`}>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
            <label className="text-xs">{t("model.field_name")}<input className={modelControl} aria-label={`${t("model.field_name")} ${i + 1}`} value={c.name} maxLength={128} onChange={e => column(c.id, { name: e.target.value })} /></label>
            <label className="text-xs">{t("model.type")}<input className={modelControl} aria-label={`${t("model.type")} ${i + 1}`} value={c.type} maxLength={256} onChange={e => column(c.id, { type: e.target.value })} /></label>
            <div className="flex items-end gap-1"><Button size="sm" disabled={busy || i === 0} aria-label={`${t("model.move_up")} ${i + 1}`} onClick={() => move(i, -1)}>↑</Button><Button size="sm" disabled={busy || i === table.columns.length - 1} aria-label={`${t("model.move_down")} ${i + 1}`} onClick={() => move(i, 1)}>↓</Button><Button size="sm" aria-label={`${t("model.remove_field")} ${i + 1}`} onClick={() => setTable({ ...table, primaryKey: modelPrimaryKey(table).filter(id => id !== c.id), columns: table.columns.filter(col => col.id !== c.id) })}>×</Button></div>
          </div>
          <div className="my-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">{(["primaryKey", "nullable", "unique"] as const).map(key => <label key={key} className="flex items-center gap-1"><input type="checkbox" checked={c[key]} disabled={busy || key === "nullable" && c.primaryKey} onChange={e => column(c.id, { [key]: e.target.checked, ...(key === "primaryKey" && e.target.checked ? { nullable: false } : {}) })} />{t(`model.${key === "primaryKey" ? "primary" : key}`)}</label>)}</div>
          <input className={modelControl} aria-label={`${t("model.comment")} ${i + 1}`} placeholder={t("model.comment")} maxLength={4096} value={c.comment} onChange={e => column(c.id, { comment: e.target.value })} />
        </fieldset>)}
      </div>
      </> : <div className="max-h-[42vh] overflow-y-auto"><ModelKeysEditor table={table} busy={busy} onChange={setTable} /></div>}
      <p className="text-xs text-muted-foreground">{t("model.metadata")}</p>
      {(error || saveError) && <p role="alert" className="text-sm text-danger">{error || saveError}</p>}
    </div>
  </Modal>;
}
export function RelationModelEditor({ model, initial, busy, visible, saveError, onSave, onClose }: { model: OfflineModel; initial: ModelRelation; busy: boolean; visible: boolean; saveError?: string | null; onSave: (next: OfflineModel) => Promise<boolean>; onClose: () => void }) {
  const t = useT(), [relation, setRelation] = useState(initial), [error, setError] = useState<string | null>(null);
  const from = model.tables.find(t => t.id === relation.fromTable), to = model.tables.find(t => t.id === relation.toTable);
  const apply = async () => { setError(null); try { const next = parseModel({ ...model, version: 2, relations: model.relations.some(r => r.id === relation.id) ? model.relations.map(r => r.id === relation.id ? relation : r) : [...model.relations, relation] }); if (await onSave(next)) onClose(); } catch (cause) { setError(modelError(cause, t)); } };
  return <Modal open={visible} closeDisabled={busy} title={t("model.edit_relation")} onClose={() => { if (!busy) onClose(); }} width={680} footer={<><Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button><Button disabled={busy} onClick={() => void apply()}>{t("model.apply")}</Button></>}>
    <fieldset disabled={busy} className="space-y-3">
      <label className="block text-xs">{t("model.relation_name")}<input className={modelControl} aria-label={t("model.relation_name")} value={relation.name} maxLength={128} onChange={e => setRelation({ ...relation, name: e.target.value })} /></label>
      <div className="grid grid-cols-2 gap-3">{(["from", "to"] as const).map(side => <label key={side} className="text-xs">{t(side === "from" ? "model.child" : "model.parent")}<select aria-label={t(side === "from" ? "model.child" : "model.parent")} className={modelControl} value={relation[`${side}Table`]} onChange={e => setRelation({ ...relation, [`${side}Table`]: e.target.value, [`${side}Columns`]: relation.fromColumns.map(() => "") })}>{model.tables.map(table => <option value={table.id} key={table.id}>{table.schema ? table.schema + "." : ""}{table.name}</option>)}</select></label>)}</div>
      <div className="flex items-center justify-between text-xs">{t("model.pairs")}<Button size="sm" disabled={busy || relation.fromColumns.length >= 16} onClick={() => setRelation({ ...relation, fromColumns: [...relation.fromColumns, ""], toColumns: [...relation.toColumns, ""] })}>{t("model.add_pair")}</Button></div>
      <div className="max-h-[30vh] space-y-2 overflow-auto">{relation.fromColumns.map((_, i) => <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">{(["from", "to"] as const).map(side => <select key={side} className={modelControl} aria-label={`${t(side === "from" ? "model.child_field" : "model.parent_field")} ${i + 1}`} value={relation[`${side}Columns`][i]} onChange={e => setRelation({ ...relation, [`${side}Columns`]: relation[`${side}Columns`].map((v, j) => j === i ? e.target.value : v) })}><option value="">—</option>{(side === "from" ? from : to)?.columns.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select>)}<Button size="sm" aria-label={`${t("model.remove_pair")} ${i + 1}`} disabled={busy || relation.fromColumns.length === 1} onClick={() => setRelation({ ...relation, fromColumns: relation.fromColumns.filter((_, j) => i !== j), toColumns: relation.toColumns.filter((_, j) => i !== j) })}>×</Button></div>)}</div>
      <label className="block text-xs">{t("model.cardinality")}<select className={modelControl} aria-label={t("model.cardinality")} value={relation.cardinality} onChange={e => setRelation({ ...relation, cardinality: e.target.value as ModelRelation["cardinality"] })}><option value="one-one">{t("model.one_one")}</option><option value="one-many">{t("model.one_many")}</option></select></label>
      <div className="grid grid-cols-2 gap-3">{(["onDelete", "onUpdate"] as const).map(key => <label key={key} className="text-xs">{t(`model.keys.${key}`)}<select className={modelControl} aria-label={t(`model.keys.${key}`)} value={relation[key] ?? "NO ACTION"} onChange={e => setRelation({ ...relation, [key]: e.target.value as ModelRelation[typeof key] })}>{MODEL_ACTIONS.map(action => <option key={action} value={action}>{action}</option>)}</select></label>)}</div>
      <p className="text-xs text-muted-foreground">{t("model.keys.actions_help")}</p>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={relation.identifying} onChange={e => setRelation({ ...relation, identifying: e.target.checked })} />{t("model.identifying")}</label>
    </fieldset>
    {(error || saveError) && <p role="alert" className="mt-3 text-sm text-danger">{error || saveError}</p>}
  </Modal>;
}
