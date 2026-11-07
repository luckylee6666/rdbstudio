import { Button } from "@/components/ui/Button";
import { MODEL_LIMITS, modelPrimaryKey, type ModelTable, type ModelUniqueKey } from "@/lib/offlineModel";
import { useT } from "@/store/i18n";

const control = "w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm";
export function ModelKeysEditor({ table, busy, onChange }: { table: ModelTable; busy: boolean; onChange: (table: ModelTable) => void }) {
  const t = useT(), primary = modelPrimaryKey(table), keys = table.uniqueKeys ?? [];
  const changeKey = (id: string, patch: Partial<ModelUniqueKey>) => onChange({ ...table, uniqueKeys: keys.map(k => k.id === id ? { ...k, ...patch } : k) });
  const reorder = (ids: string[], i: number, step: number) => { const next = [...ids]; [next[i], next[i + step]] = [next[i + step], next[i]]; return next; };
  return <fieldset disabled={busy} className="space-y-4">
    <section className="space-y-2 rounded-md bg-surface-muted/50 p-3">
      <h3 className="text-sm font-medium">{t("model.keys.primary_order")}</h3>
      <p className="text-xs text-muted-foreground">{t("model.keys.primary_help")}</p>
      {primary.map((id, i) => <div key={id} className="flex items-center gap-2 text-xs"><span className="text-muted-foreground">{i + 1}</span><span className="min-w-0 flex-1 truncate">{table.columns.find(c => c.id === id)?.name}</span><Button size="sm" disabled={busy || i === 0} aria-label={`${t("model.keys.primary_up")} ${i + 1}`} onClick={() => onChange({ ...table, primaryKey: reorder(primary, i, -1) })}>↑</Button><Button size="sm" disabled={busy || i === primary.length - 1} aria-label={`${t("model.keys.primary_down")} ${i + 1}`} onClick={() => onChange({ ...table, primaryKey: reorder(primary, i, 1) })}>↓</Button></div>)}
    </section>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">{t("model.keys.unique")} · {keys.length}</h3><Button size="sm" disabled={busy || !table.columns.length || keys.length >= MODEL_LIMITS.keys} onClick={() => {
      let n = keys.length + 1; while (keys.some(k => k.name.toLowerCase() === `unique_${n}`)) n++;
      onChange({ ...table, uniqueKeys: [...keys, { id: crypto.randomUUID(), name: `unique_${n}`, columns: [table.columns[0].id] }] });
    }}>{t("model.keys.add")}</Button></div>
    {keys.map((key, index) => <section key={key.id} className="space-y-2 rounded-md border border-border p-3" aria-label={`${t("model.keys.unique")} ${index + 1}`}>
      <div className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs">{t("model.keys.name")}<input className={control} aria-label={`${t("model.keys.name")} ${index + 1}`} value={key.name} maxLength={128} onChange={e => changeKey(key.id, { name: e.target.value })} /></label><Button size="sm" aria-label={`${t("model.keys.remove")} ${index + 1}`} onClick={() => onChange({ ...table, uniqueKeys: keys.filter(k => k.id !== key.id) })}>{t("common.delete")}</Button></div>
      {key.columns.map((id, i) => <div key={i} className="flex items-center gap-1"><span className="w-4 text-xs text-muted-foreground">{i + 1}</span><select className={control} aria-label={`${t("model.keys.field")} ${index + 1}.${i + 1}`} value={id} onChange={e => changeKey(key.id, { columns: key.columns.map((v, j) => j === i ? e.target.value : v) })}>{table.columns.map(c => <option key={c.id} value={c.id} disabled={c.id !== id && key.columns.includes(c.id)}>{c.name}</option>)}</select><Button size="sm" disabled={busy || i === 0} aria-label={`${t("model.keys.up")} ${index + 1}.${i + 1}`} onClick={() => changeKey(key.id, { columns: reorder(key.columns, i, -1) })}>↑</Button><Button size="sm" disabled={busy || i === key.columns.length - 1} aria-label={`${t("model.keys.down")} ${index + 1}.${i + 1}`} onClick={() => changeKey(key.id, { columns: reorder(key.columns, i, 1) })}>↓</Button><Button size="sm" disabled={busy || key.columns.length === 1} aria-label={`${t("model.keys.remove_field")} ${index + 1}.${i + 1}`} onClick={() => changeKey(key.id, { columns: key.columns.filter((_, j) => j !== i) })}>×</Button></div>)}
      <Button size="sm" disabled={busy || key.columns.length >= table.columns.length} onClick={() => { const next = table.columns.find(c => !key.columns.includes(c.id)); if (next) changeKey(key.id, { columns: [...key.columns, next.id] }); }}>{t("model.keys.add_field")}</Button>
    </section>)}
  </fieldset>;
}
