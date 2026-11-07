import { Plus, Trash2 } from "lucide-react";
import { ToolSelect } from "@/components/tools/ToolKit";
import { useT } from "@/store/i18n";
import { comparisonOperators, emptyGroup, type ConditionGroup, type ComparisonOperator, type Condition } from "@/lib/queryBuilder";
import { defaultColumn, ExpressionEditor, textValue, type ExpressionContext } from "./ExpressionEditor";

export const smallButton = "inline-flex min-h-8 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-40";
export function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return <button type="button" className={smallButton} onClick={onClick} aria-label={label} title={label}><Trash2 className="h-3.5 w-3.5" /></button>;
}
export function ConditionEditor({ value, onChange, context, label, depth = 0 }: {
  value: ConditionGroup; onChange: (group: ConditionGroup) => void; context: ExpressionContext; label: string; depth?: number;
}) {
  const t = useT();
  const update = (index: number, next: Condition) => onChange({ ...value, children: value.children.map((child, i) => i === index ? next : child) });
  return <fieldset className="min-w-0 rounded-lg border border-border/70 p-2.5">
    <legend className="px-1 text-xs text-muted-foreground">{label}</legend>
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <ToolSelect aria-label={`${label} · ${t("builder.logic")}`} value={value.logic} onChange={e => onChange({ ...value, logic: e.target.value as "AND" | "OR" })}><option>AND</option><option>OR</option></ToolSelect>
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={value.not} onChange={e => onChange({ ...value, not: e.target.checked })} />NOT</label>
      <button className={smallButton} onClick={() => onChange({ ...value, children: [...value.children, { id: crypto.randomUUID(), kind: "rule", left: defaultColumn(context), op: "=", values: [textValue()] }] })}><Plus className="h-3 w-3" />{t("builder.add_condition")}</button>
      <button className={smallButton} disabled={depth >= 8} onClick={() => onChange({ ...value, children: [...value.children, emptyGroup()] })}><Plus className="h-3 w-3" />{t("builder.add_group")}</button>
    </div>
    <div className="space-y-2">
      {value.children.map((child, index) => <div key={child.id} className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1">
          {child.kind === "group" ? <ConditionEditor value={child} onChange={next => update(index, next)} context={context} label={`${label}.${index + 1}`} depth={depth + 1} /> : <div className="space-y-2 rounded-md bg-background/50 p-2">
            <ExpressionEditor value={child.left} onChange={left => update(index, { ...child, left })} context={context} label={`${label} ${index + 1} · ${t("builder.left")}`} />
            <div className="flex flex-wrap items-start gap-2">
              <ToolSelect aria-label={`${label} ${index + 1} · ${t("builder.operator")}`} value={child.op} onChange={e => {
                const op = e.target.value as ComparisonOperator;
                const count = op.includes("NULL") ? 0 : op.includes("BETWEEN") ? 2 : 1;
                update(index, { ...child, op, values: Array.from({ length: count }, (_, i) => child.values[i] ?? textValue()) });
              }}>{comparisonOperators.map(op => <option key={op}>{op}</option>)}</ToolSelect>
              <div className="min-w-0 flex-1 space-y-2">
                {child.values.map((expression, valueIndex) => <div key={valueIndex} className="flex items-start gap-1">
                  <ExpressionEditor value={expression} onChange={next => update(index, { ...child, values: child.values.map((old, i) => i === valueIndex ? next : old) })} context={context} label={`${label} ${index + 1} · ${t("builder.value")} ${valueIndex + 1}`} />
                  {(child.op === "IN" || child.op === "NOT IN") && child.values.length > 1 && <RemoveButton label={`${label} ${index + 1} · ${t("builder.remove_value")} ${valueIndex + 1}`} onClick={() => update(index, { ...child, values: child.values.filter((_, i) => i !== valueIndex) })} />}
                </div>)}
                {(child.op === "IN" || child.op === "NOT IN") && <button className={smallButton} onClick={() => update(index, { ...child, values: [...child.values, textValue()] })}><Plus className="h-3 w-3" />{t("builder.add_value")}</button>}
              </div>
            </div>
          </div>}
        </div>
        <RemoveButton label={`${label} · ${t("builder.remove_condition")} ${index + 1}`} onClick={() => onChange({ ...value, children: value.children.filter((_, i) => i !== index) })} />
      </div>)}
    </div>
  </fieldset>;
}
