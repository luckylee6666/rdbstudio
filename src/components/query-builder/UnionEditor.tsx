import { useT } from "@/store/i18n";
import { ToolCard, ToolSelect } from "@/components/tools/ToolKit";
import type { Expression, QueryDesign } from "@/lib/queryBuilder";
import { builderInput } from "./ExpressionEditor";
import { RemoveButton, smallButton } from "./ConditionEditor";

type Orders = QueryDesign["orderBy"];

export function UnionOrderEditor({ order, onChange }: { order: Orders; onChange: (next: Orders) => void }) {
  const t = useT();
  const replace = (index: number, patch: Partial<Orders[number]>) =>
    onChange(order.map((item, i) => i === index ? { ...item, ...patch } : item));
  const key = (ordinal: boolean, value: string): Expression => ordinal
    ? { kind: "literal", type: "number", value }
    : { kind: "column", tableId: null, name: value };
  return <ToolCard title={t("builder.union_order")}>
    {order.map((item, i) => {
      const ordinal = item.expression.kind === "literal" && item.expression.type === "number";
      const value = item.expression.kind === "column" ? item.expression.name : item.expression.kind === "literal" ? item.expression.value : "";
      return <div key={item.id} className="mb-2 flex flex-wrap items-center gap-2">
        <ToolSelect aria-label={`${t("builder.kind")} ${i + 1}`} value={ordinal ? "position" : "name"}
          onChange={e => replace(i, { expression: key(e.target.value === "position", e.target.value === "position" ? "1" : "") })}>
          <option value="name">{t("builder.output_name")}</option><option value="position">{t("builder.output_position")}</option>
        </ToolSelect>
        <input className={builderInput} aria-label={`${t(ordinal ? "builder.output_position" : "builder.output_name")} ${i + 1}`}
          value={value} onChange={e => replace(i, { expression: key(ordinal, e.target.value) })} />
        <ToolSelect aria-label={`${t("builder.direction")} ${i + 1}`} value={item.direction}
          onChange={e => replace(i, { direction: e.target.value as "ASC" | "DESC" })}><option>ASC</option><option>DESC</option></ToolSelect>
        <RemoveButton label={`${t("builder.remove_expression")} ${i + 1}`} onClick={() => onChange(order.filter((_, index) => i !== index))} />
      </div>;
    })}
    <button className={smallButton} onClick={() => onChange([...order, { id: crypto.randomUUID(), expression: key(true, "1"), direction: "ASC" }])}>{t("builder.add_expression")}</button>
  </ToolCard>;
}
