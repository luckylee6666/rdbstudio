import { useMemo, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { ColumnInfo, Filter, FilterOp } from "@/types";
import { cn } from "@/lib/cn";
import { useT } from "@/store/i18n";

interface Props {
  columns: ColumnInfo[];
  filters: Filter[];
  whereRaw: string;
  onApply: (filters: Filter[], whereRaw: string) => void;
  onClose: () => void;
}

interface Condition {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
}

const OPS: { value: FilterOp; label: string; hideValue?: boolean }[] = [
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "is_null", label: "is NULL", hideValue: true },
  { value: "not_null", label: "is NOT NULL", hideValue: true },
];

function filtersToConds(filters: Filter[]): Condition[] {
  return filters.map((f, i) => ({
    id: `c${i}`,
    column: f.column,
    op: f.op,
    value: f.value ?? "",
  }));
}

function condsToFilters(conds: Condition[]): Filter[] {
  return conds
    .filter((c) => c.column)
    .map((c) => {
      const op = c.op;
      const hideValue = OPS.find((o) => o.value === op)?.hideValue ?? false;
      return {
        column: c.column,
        op,
        value: hideValue ? undefined : c.value,
      };
    });
}

export function FilterBuilder({
  columns,
  filters,
  whereRaw,
  onApply,
  onClose,
}: Props) {
  const t = useT();
  const [mode, setMode] = useState<"builder" | "sql">(
    whereRaw ? "sql" : "builder"
  );
  const [conds, setConds] = useState<Condition[]>(() => {
    const c = filtersToConds(filters);
    if (c.length === 0 && columns.length > 0) {
      return [{ id: "c0", column: columns[0].name, op: "contains", value: "" }];
    }
    return c;
  });
  const [sql, setSql] = useState(whereRaw ?? "");

  const addCond = () => {
    setConds((cs) => [
      ...cs,
      {
        id: `c${Date.now()}`,
        column: columns[0]?.name ?? "",
        op: "contains",
        value: "",
      },
    ]);
  };

  const removeCond = (id: string) =>
    setConds((cs) => cs.filter((c) => c.id !== id));

  const updateCond = (id: string, patch: Partial<Condition>) =>
    setConds((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  const apply = () => {
    if (mode === "sql") {
      onApply([], sql.trim());
    } else {
      onApply(condsToFilters(conds), "");
    }
  };

  const clearAll = () => {
    setConds([]);
    setSql("");
    onApply([], "");
  };

  const previewCount = useMemo(() => {
    if (mode === "sql") return sql.trim() ? 1 : 0;
    return conds.filter((c) => c.column).length;
  }, [mode, sql, conds]);

  return (
    <div className="shrink-0 border-b border-border/70 bg-surface-elevated/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2 text-[12px]">
        <div className="flex items-center gap-0.5 rounded-md bg-surface-muted p-0.5">
          <button
            onClick={() => setMode("builder")}
            className={cn(
              "rounded px-2 py-0.5 text-[11.5px]",
              mode === "builder"
                ? "bg-surface text-foreground shadow-soft"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("filter.mode.builder")}
          </button>
          <button
            onClick={() => setMode("sql")}
            className={cn(
              "rounded px-2 py-0.5 text-[11.5px]",
              mode === "sql"
                ? "bg-surface text-foreground shadow-soft"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("filter.mode.sql")}
          </button>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {t("filter.count", { n: previewCount })}
        </span>
        <div className="flex-1" />
        <button
          onClick={clearAll}
          className="flex h-6 items-center gap-1 rounded px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="h-3 w-3" />
          {t("filter.clear")}
        </button>
        <button
          onClick={apply}
          className="flex h-6 items-center gap-1 rounded bg-brand px-2 font-medium text-brand-foreground hover:bg-brand/90"
        >
          {t("filter.apply")}
        </button>
        <button
          onClick={onClose}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3 w-3" />
        </button>
      </div>

      <div className="px-3 py-2">
        {mode === "builder" ? (
          <div className="space-y-1.5">
            {conds.map((c, i) => {
              const op = OPS.find((o) => o.value === c.op);
              const hideValue = op?.hideValue ?? false;
              return (
                <div key={c.id} className="flex items-center gap-2 text-[12px]">
                  <span className="w-10 shrink-0 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                    {i === 0 ? t("filter.where") : t("filter.and")}
                  </span>
                  <select
                    value={c.column}
                    onChange={(e) => updateCond(c.id, { column: e.target.value })}
                    className="h-7 w-[180px] rounded-md border border-border/70 bg-surface px-2 text-[12px] focus:border-brand/60 focus:outline-none"
                  >
                    {columns.map((col) => (
                      <option key={col.name} value={col.name}>
                        {col.name}
                        {col.is_primary_key ? " · PK" : ""}
                      </option>
                    ))}
                  </select>
                  <select
                    value={c.op}
                    onChange={(e) =>
                      updateCond(c.id, { op: e.target.value as FilterOp })
                    }
                    className="h-7 w-[130px] rounded-md border border-border/70 bg-surface px-2 text-[12px] focus:border-brand/60 focus:outline-none"
                  >
                    {OPS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input
                    value={c.value}
                    disabled={hideValue}
                    placeholder={hideValue ? "" : "value…"}
                    onChange={(e) => updateCond(c.id, { value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") apply();
                    }}
                    className="h-7 flex-1 rounded-md border border-border/70 bg-surface px-2 font-mono text-[12px] placeholder:text-muted-foreground/50 focus:border-brand/60 focus:outline-none disabled:bg-surface-muted disabled:text-muted-foreground/50"
                  />
                  <button
                    onClick={() => removeCond(c.id)}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-danger/15 hover:text-danger"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              );
            })}
            <button
              onClick={addCond}
              className="flex h-7 items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-[12px] text-muted-foreground hover:border-brand/60 hover:bg-accent/40 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("filter.add_condition")}
            </button>
          </div>
        ) : (
          <div>
            <div className="mb-1 text-[10.5px] uppercase tracking-wider text-muted-foreground">
              {t("filter.where_clause")}
            </div>
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) apply();
              }}
              rows={3}
              placeholder="email IS NOT NULL AND created_at > '2026-01-01'"
              className="w-full rounded-md border border-border/70 bg-surface px-2.5 py-2 font-mono text-[12.5px] placeholder:text-muted-foreground/50 focus:border-brand/60 focus:outline-none"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("filter.sql_hint")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
