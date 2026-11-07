import { useT } from "@/store/i18n";
import { ToolSelect } from "@/components/tools/ToolKit";
import type { ColumnInfo } from "@/types";
import type { ColumnExpression, Expression, QuerySource } from "@/lib/queryBuilder";

export const builderInput = "h-9 min-w-0 rounded-md border border-border/80 bg-surface px-2.5 text-[13px] outline-none focus:border-brand focus:ring-2 focus:ring-ring/30";
export interface ExpressionContext { sources: QuerySource[]; columns: Record<string, ColumnInfo[]> }
export function defaultColumn(context: ExpressionContext): ColumnExpression {
  const source = context.sources[0];
  return { kind: "column", tableId: source?.id ?? "", name: context.columns[source?.id]?.[0]?.name ?? "" };
}
export function textValue(): Expression { return { kind: "literal", type: "text", value: "" }; }

function ColumnPicker({ value, onChange, context, label, star = false }: {
  value: ColumnExpression | null; onChange: (value: ColumnExpression | null) => void;
  context: ExpressionContext; label: string; star?: boolean;
}) {
  const t = useT();
  const options = context.sources.flatMap(source => (context.columns[source.id] ?? []).map(column => ({
    key: JSON.stringify([source.id, column.name]), label: `${source.alias}.${column.name}`,
  })));
  const selected = value ? JSON.stringify([value.tableId, value.name]) : "*";
  return <ToolSelect className="min-w-[130px] flex-1" aria-label={label} value={selected} onChange={e => {
    if (e.target.value === "*") onChange(null);
    else {
      const [tableId, name] = JSON.parse(e.target.value) as [string, string];
      onChange({ kind: "column", tableId, name });
    }
  }}>
    {star && <option value="*">*</option>}
    {!options.some(option => option.key === selected) && value && <option value={selected}>{value.name ? `${context.sources.find(s => s.id === value.tableId)?.alias ?? "?"}.${value.name}` : t("builder.choose_column")}</option>}
    {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
  </ToolSelect>;
}

export function ExpressionEditor({ value, onChange, context, label }: {
  value: Expression; onChange: (value: Expression) => void; context: ExpressionContext; label: string;
}) {
  const t = useT();
  return <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
    <ToolSelect aria-label={`${label} · ${t("builder.kind")}`} className="w-32 shrink-0" value={value.kind} onChange={e => {
      switch (e.target.value) {
        case "column": onChange(defaultColumn(context)); break;
        case "aggregate": onChange({ kind: "aggregate", fn: "COUNT", column: null, distinct: false }); break;
        case "literal": onChange(textValue()); break;
        case "sql": onChange({ kind: "sql", text: "" }); break;
      }
    }}>
      {(["column", "aggregate", "literal", "sql"] as const).map(kind => <option key={kind} value={kind}>{t(`builder.kind.${kind}`)}</option>)}
    </ToolSelect>
    {value.kind === "column" && <ColumnPicker value={value} onChange={column => column && onChange(column)} context={context} label={label} />}
    {value.kind === "aggregate" && <>
      <ToolSelect aria-label={`${label} · ${t("builder.function")}`} value={value.fn} onChange={e => onChange({ ...value, fn: e.target.value as typeof value.fn, column: e.target.value === "COUNT" ? value.column : value.column ?? defaultColumn(context) })}>
        {["COUNT", "SUM", "AVG", "MIN", "MAX"].map(fn => <option key={fn}>{fn}</option>)}
      </ToolSelect>
      <ColumnPicker value={value.column} onChange={column => onChange({ ...value, column, distinct: column ? value.distinct : false })} context={context} label={label} star={value.fn === "COUNT" && !value.distinct} />
      <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={value.distinct} onChange={e => onChange({ ...value, distinct: e.target.checked, column: value.column ?? defaultColumn(context) })} />DISTINCT</label>
    </>}
    {value.kind === "literal" && <>
      <ToolSelect aria-label={`${label} · ${t("builder.type")}`} value={value.type} onChange={e => onChange({ ...value, type: e.target.value as typeof value.type, value: e.target.value === "boolean" ? "true" : "" })}>
        {["text", "number", "boolean", "null"].map(type => <option key={type} value={type}>{t(`builder.type.${type}`)}</option>)}
      </ToolSelect>
      {value.type === "boolean" ? <ToolSelect aria-label={label} value={value.value} onChange={e => onChange({ ...value, value: e.target.value })}><option value="true">TRUE</option><option value="false">FALSE</option></ToolSelect>
        : value.type !== "null" && <input aria-label={label} className={`${builderInput} flex-1`} value={value.value} onChange={e => onChange({ ...value, value: e.target.value })} />}
    </>}
    {value.kind === "sql" && <input aria-label={label} className={`${builderInput} min-w-[120px] flex-1 font-mono`} placeholder={t("builder.expression_hint")} value={value.text} onChange={e => onChange({ ...value, text: e.target.value })} />}
  </div>;
}
