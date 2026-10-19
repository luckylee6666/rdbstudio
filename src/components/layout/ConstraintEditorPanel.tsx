import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, KeyRound, Link2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import { ToolField, ToolSelect } from "@/components/tools/ToolKit";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useT } from "@/store/i18n";
import { toast } from "@/store/toasts";
import type { DriverKind, ForeignKey, IndexInfo } from "@/types";

type ForeignKeyDraft = {
  name: string;
  columns: string[];
  referenced_schema?: string | null;
  referenced_table: string;
  referenced_columns: string[];
  on_update?: string | null;
  on_delete?: string | null;
};
type IndexDraft = {
  old?: string;
  name: string;
  columns: string[];
  prefixes: Record<string, string>;
  unique: boolean;
  method: string;
};

const FK_ACTIONS = ["NO ACTION", "RESTRICT", "SET NULL", "SET DEFAULT", "CASCADE"];
const PG_METHODS = ["btree", "hash", "gist", "gin", "brin", "spgist"];
const MYSQL_METHODS = ["BTREE", "HASH"];

export function ConstraintEditorPanel(props: {
  id: string;
  schema?: string | null;
  table: string;
  driver: DriverKind;
  columns: string[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKey[];
  readOnly?: boolean;
  initialMode?: "index" | "foreign_key";
  onSaved: () => void;
}) {
  const t = useT();
  const mode = props.initialMode ?? "index";
  const [indexDraft, setIndexDraft] = useState<IndexDraft | null>(null);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyDraft[]>([]);
  const [editingFk, setEditingFk] = useState<number | null>(null);
  const [fkDraft, setFkDraft] = useState<ForeignKeyDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDrop, setPendingDrop] = useState<
    { kind: "index"; name: string } | { kind: "fk"; index: number; name: string } | null
  >(null);

  useEffect(() => {
    setForeignKeys(
      props.foreignKeys.map((fk) => ({
        ...fk,
        columns: [...fk.columns],
        referenced_columns: [...fk.referenced_columns],
      }))
    );
  }, [props.foreignKeys]);
  useEffect(() => {
    setIndexDraft(null);
    setFkDraft(null);
  }, [mode]);

  const invokeSave = async (command: string, args: Record<string, unknown>) => {
    setBusy(true);
    try {
      await invoke(command, args);
      toast.success(t("constraints.saved"));
      setIndexDraft(null);
      setFkDraft(null);
      setEditingFk(null);
      props.onSaved();
    } catch (e) {
      toast.error(t("constraints.failed"), String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveIndex = () => {
    if (!indexDraft || indexDraft.columns.length === 0) return;
    const prefixLengths =
      props.driver === "mysql"
        ? indexDraft.columns.map((c) => {
            const raw = indexDraft.prefixes[c]?.trim();
            if (!raw) return null;
            const value = Number(raw);
            return Number.isSafeInteger(value) && value > 0 ? value : NaN;
          })
        : [];
    if (prefixLengths.some((v) => typeof v === "number" && !Number.isFinite(v))) {
      toast.error(t("constraints.failed"), t("constraints.prefix_invalid"));
      return;
    }
    const common = {
      name: indexDraft.name,
      columns: indexDraft.columns,
      unique: indexDraft.unique,
      method: indexDraft.method || null,
      prefix_lengths: prefixLengths,
    };
    void invokeSave("apply_index_change", {
      id: props.id,
      schema: props.schema ?? null,
      table: props.table,
      change: indexDraft.old
        ? { operation: "replace", old_name: indexDraft.old, ...common }
        : { operation: "create", ...common },
    });
  };

  const saveForeignKeys = (next: ForeignKeyDraft[]) => {
    void invokeSave("apply_foreign_key_changes", {
      id: props.id,
      schema: props.schema ?? null,
      table: props.table,
      foreign_keys: next.map((fk) => ({
        ...fk,
        on_update: fk.on_update || null,
        on_delete: fk.on_delete || null,
      })),
    });
  };

  const startIndex = (index?: IndexInfo) =>
    setIndexDraft(
      index
        ? {
            old: index.name,
            name: index.name,
            columns: [...index.columns],
            prefixes: {},
            unique: index.is_unique,
            method: index.method ?? "",
          }
        : {
            name: `idx_${props.table}`,
            columns: [],
            prefixes: {},
            unique: false,
            method: props.driver === "postgres" ? "btree" : "",
          }
    );

  const commitFkDraft = () => {
    if (!fkDraft) return;
    const next = foreignKeys.slice();
    if (editingFk == null) next.push(fkDraft);
    else next[editingFk] = fkDraft;
    setForeignKeys(next);
    saveForeignKeys(next);
  };

  const confirmDrop = () => {
    if (!pendingDrop) return;
    if (pendingDrop.kind === "index") {
      void invokeSave("apply_index_change", {
        id: props.id,
        schema: props.schema ?? null,
        table: props.table,
        change: { operation: "drop", name: pendingDrop.name },
      });
    } else {
      saveForeignKeys(foreignKeys.filter((_, i) => i !== pendingDrop.index));
    }
    setPendingDrop(null);
  };

  const editable = !props.readOnly && !busy;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 bg-surface/30 px-4">
        <span className="text-[12px] text-muted-foreground">
          {mode === "index"
            ? t("constraints.index_count", { n: props.indexes.length })
            : t("constraints.fk_count", { n: foreignKeys.length })}
        </span>
        {props.readOnly && (
          <span className="rounded-md bg-warning/15 px-2 py-0.5 text-[11px] text-warning">{t("objects.read_only")}</span>
        )}
        <div className="flex-1" />
        <button
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          onClick={props.onSaved}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
        </button>
        <Button
          size="sm"
          variant="primary"
          disabled={!editable}
          onClick={() => {
            if (mode === "index") startIndex();
            else {
              setEditingFk(null);
              setFkDraft({
                name: `fk_${props.table}_${foreignKeys.length + 1}`,
                columns: [],
                referenced_table: "",
                referenced_columns: [],
                on_update: "NO ACTION",
                on_delete: "NO ACTION",
              });
            }
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          {mode === "index" ? t("constraints.new_index") : t("constraints.new_fk")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        {props.driver === "sqlite" && (
          <p className="rounded-lg border border-border/60 bg-surface/40 px-3 py-2 text-[11.5px] text-muted-foreground">
            {t("constraints.sqlite_rebuild")}
          </p>
        )}

        {mode === "index" && indexDraft && (
          <section className="rounded-xl border border-brand/40 bg-surface/60 p-4 shadow-soft">
            <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
              <ToolField label={t("constraints.name")}>
                <Input value={indexDraft.name} onChange={(e) => setIndexDraft({ ...indexDraft, name: e.target.value })} />
              </ToolField>
              {props.driver !== "sqlite" && (
                <ToolField label={t("constraints.method")}>
                  <ToolSelect
                    value={indexDraft.method}
                    onChange={(e) => setIndexDraft({ ...indexDraft, method: e.target.value })}
                    className="w-32"
                  >
                    {props.driver === "mysql" && <option value="">{t("constraints.default")}</option>}
                    {(props.driver === "postgres" ? PG_METHODS : MYSQL_METHODS).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </ToolSelect>
                </ToolField>
              )}
              <ToolField label={t("constraints.unique")}>
                <label className="flex h-9 items-center gap-2 text-[12.5px]">
                  <input
                    type="checkbox"
                    checked={indexDraft.unique}
                    onChange={(e) => setIndexDraft({ ...indexDraft, unique: e.target.checked })}
                  />
                  UNIQUE
                </label>
              </ToolField>
            </div>
            <div className="mt-3">
              <ToolField label={t("constraints.columns")} hint={t("constraints.columns_hint")}>
                <ColumnChips
                  options={props.columns}
                  value={indexDraft.columns}
                  onChange={(columns) => setIndexDraft({ ...indexDraft, columns })}
                />
              </ToolField>
            </div>
            {props.driver === "mysql" && indexDraft.columns.length > 0 && (
              <div className="mt-3">
                <ToolField label={t("constraints.prefix")} hint={t("constraints.prefix_hint")}>
                  <div className="flex flex-wrap gap-2">
                    {indexDraft.columns.map((c) => (
                      <label key={c} className="flex items-center gap-1.5 text-[12px]">
                        <span className="font-mono text-muted-foreground">{c}</span>
                        <Input
                          inputMode="numeric"
                          className="h-8 w-16 text-[12px]"
                          value={indexDraft.prefixes[c] ?? ""}
                          onChange={(e) =>
                            setIndexDraft({ ...indexDraft, prefixes: { ...indexDraft.prefixes, [c]: e.target.value } })
                          }
                        />
                      </label>
                    ))}
                  </div>
                </ToolField>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Button onClick={() => setIndexDraft(null)}>{t("common.cancel")}</Button>
              <Button variant="primary" disabled={!editable || indexDraft.columns.length === 0 || !indexDraft.name.trim()} onClick={saveIndex}>
                {t("common.save")}
              </Button>
            </div>
          </section>
        )}

        {mode === "foreign_key" && fkDraft && (
          <ForeignKeyForm
            connectionId={props.id}
            schema={props.schema}
            columns={props.columns}
            draft={fkDraft}
            onChange={setFkDraft}
            onCancel={() => setFkDraft(null)}
            onSave={commitFkDraft}
            disabled={!editable}
          />
        )}

        {mode === "index" ? (
          props.indexes.length === 0 ? (
            <p className="py-10 text-center text-[12px] text-muted-foreground">{t("constraints.none")}</p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border/70">
              {props.indexes.map((index) => (
                <div key={index.name} className="flex items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0 hover:bg-accent/30">
                  <KeyRound className={cn("h-3.5 w-3.5 shrink-0", index.is_primary ? "text-warning" : "text-muted-foreground")} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[12.5px]">{index.name}</div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">({index.columns.join(", ")})</div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {index.is_primary && <Badge tone="warning">PRIMARY</Badge>}
                    {index.is_unique && !index.is_primary && <Badge tone="brand">UNIQUE</Badge>}
                    {index.method && <Badge>{index.method}</Badge>}
                  </div>
                  <IconAction label={t("common.edit")} disabled={!editable || index.is_primary} onClick={() => startIndex(index)}>
                    <Pencil className="h-3.5 w-3.5" />
                  </IconAction>
                  <IconAction
                    label={t("common.delete")}
                    danger
                    disabled={!editable || index.is_primary}
                    onClick={() => setPendingDrop({ kind: "index", name: index.name })}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconAction>
                </div>
              ))}
            </div>
          )
        ) : foreignKeys.length === 0 && !fkDraft ? (
          <p className="py-10 text-center text-[12px] text-muted-foreground">{t("constraints.none")}</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/70">
            {foreignKeys.map((fk, index) => (
              <div key={`${fk.name}-${index}`} className="flex items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0 hover:bg-accent/30">
                <Link2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12.5px]">{fk.name}</div>
                  <div className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted-foreground">
                    ({fk.columns.join(", ")})
                    <ArrowRight className="h-3 w-3 shrink-0" />
                    {fk.referenced_schema ? `${fk.referenced_schema}.` : ""}
                    {fk.referenced_table} ({fk.referenced_columns.join(", ")})
                  </div>
                </div>
                <div className="hidden shrink-0 gap-1.5 lg:flex">
                  <Badge>ON UPDATE {fk.on_update ?? "NO ACTION"}</Badge>
                  <Badge>ON DELETE {fk.on_delete ?? "NO ACTION"}</Badge>
                </div>
                <IconAction
                  label={t("common.edit")}
                  disabled={!editable}
                  onClick={() => {
                    setEditingFk(index);
                    setFkDraft({ ...fk, columns: [...fk.columns], referenced_columns: [...fk.referenced_columns] });
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </IconAction>
                <IconAction
                  label={t("common.delete")}
                  danger
                  disabled={!editable}
                  onClick={() => setPendingDrop({ kind: "fk", index, name: fk.name })}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </IconAction>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDrop !== null}
        title={t("common.delete")}
        message={t("objects.drop_confirm", { name: pendingDrop?.name ?? "" })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={confirmDrop}
        onClose={() => setPendingDrop(null)}
      />
    </div>
  );
}

function ForeignKeyForm({
  connectionId,
  schema,
  columns,
  draft,
  onChange,
  onCancel,
  onSave,
  disabled,
}: {
  connectionId: string;
  schema?: string | null;
  columns: string[];
  draft: ForeignKeyDraft;
  onChange: (draft: ForeignKeyDraft) => void;
  onCancel: () => void;
  onSave: () => void;
  disabled: boolean;
}) {
  const t = useT();
  const [tables, setTables] = useState<string[]>([]);
  const [refColumns, setRefColumns] = useState<string[]>([]);
  const refSchema = draft.referenced_schema ?? schema ?? undefined;

  useEffect(() => {
    api
      .listTables(connectionId, refSchema ?? undefined)
      .then((list) => setTables((list ?? []).filter((e) => e.kind === "table").map((e) => e.name)))
      .catch(() => setTables([]));
  }, [connectionId, refSchema]);
  useEffect(() => {
    if (!draft.referenced_table) {
      setRefColumns([]);
      return;
    }
    api
      .listColumns(connectionId, draft.referenced_table, refSchema ?? undefined)
      .then((cols) => setRefColumns((cols ?? []).map((c) => c.name)))
      .catch(() => setRefColumns([]));
  }, [connectionId, draft.referenced_table, refSchema]);

  const valid =
    draft.name.trim() &&
    draft.columns.length > 0 &&
    draft.referenced_table &&
    draft.referenced_columns.length === draft.columns.length;

  return (
    <section className="rounded-xl border border-brand/40 bg-surface/60 p-4 shadow-soft">
      <div className="grid gap-3 md:grid-cols-2">
        <ToolField label={t("constraints.name")}>
          <Input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        </ToolField>
        <ToolField label={t("constraints.ref_table")}>
          <ToolSelect
            value={draft.referenced_table}
            onChange={(e) => onChange({ ...draft, referenced_table: e.target.value, referenced_columns: [] })}
          >
            <option value="">—</option>
            {!tables.includes(draft.referenced_table) && draft.referenced_table && (
              <option value={draft.referenced_table}>{draft.referenced_table}</option>
            )}
            {tables.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </ToolSelect>
        </ToolField>
        <ToolField label={t("constraints.columns")}>
          <ColumnChips options={columns} value={draft.columns} onChange={(next) => onChange({ ...draft, columns: next })} />
        </ToolField>
        <ToolField
          label={t("constraints.ref_columns")}
          hint={draft.columns.length > 0 ? t("constraints.ref_columns_hint", { n: draft.columns.length }) : undefined}
        >
          <ColumnChips
            options={refColumns}
            value={draft.referenced_columns}
            onChange={(next) => onChange({ ...draft, referenced_columns: next })}
          />
        </ToolField>
        <ToolField label={t("constraints.on_update")}>
          <ToolSelect value={draft.on_update ?? "NO ACTION"} onChange={(e) => onChange({ ...draft, on_update: e.target.value })}>
            {FK_ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </ToolSelect>
        </ToolField>
        <ToolField label={t("constraints.on_delete")}>
          <ToolSelect value={draft.on_delete ?? "NO ACTION"} onChange={(e) => onChange({ ...draft, on_delete: e.target.value })}>
            {FK_ACTIONS.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </ToolSelect>
        </ToolField>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={disabled || !valid} onClick={onSave}>
          {t("common.save")}
        </Button>
      </div>
    </section>
  );
}

/** Ordered multi-select: click order defines the key column order. */
function ColumnChips({ options, value, onChange }: { options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  if (options.length === 0) return <p className="py-2 text-[12px] text-muted-foreground">—</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((c) => {
        const position = value.indexOf(c);
        const on = position >= 0;
        return (
          <button
            key={c}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== c) : [...value, c])}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-full border px-2.5 font-mono text-[11.5px] transition-colors",
              on ? "border-brand/60 bg-brand/15 text-brand" : "border-border/70 text-muted-foreground hover:text-foreground"
            )}
          >
            {on && (
              <span className="grid h-4 w-4 place-items-center rounded-full bg-brand text-[9.5px] font-semibold text-brand-foreground">
                {position + 1}
              </span>
            )}
            {c}
          </button>
        );
      })}
    </div>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: "brand" | "warning" }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 font-mono text-[10px] tracking-wide",
        tone === "brand" ? "bg-brand/15 text-brand" : tone === "warning" ? "bg-warning/15 text-warning" : "bg-surface-muted text-muted-foreground"
      )}
    >
      {children}
    </span>
  );
}

function IconAction({
  label,
  danger,
  children,
  ...props
}: { label: string; danger?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...props}
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors disabled:pointer-events-none disabled:opacity-30",
        danger ? "text-danger hover:bg-danger/10" : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}
