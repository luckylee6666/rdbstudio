import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clipboard,
  Columns3,
  KeyRound,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  ScrollText,
  Trash2,
  Undo2,
} from "lucide-react";
import type {
  AlterPlan,
  ColumnDetail,
  ColumnEdit,
  ForeignKey,
  IndexInfo,
  TableDescription,
  WorkspaceTab,
} from "@/types";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/store/toasts";
import { ReadOnlySql } from "@/components/editor/ReadOnlySql";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useT } from "@/store/i18n";

type SubTab = "columns" | "indexes" | "fks" | "ddl";

export function DesignerView({ tab }: { tab: WorkspaceTab }) {
  const connectionId = tab.connectionId!;
  const schema = tab.schema;
  const table = tab.table ?? tab.title;

  const [desc, setDesc] = useState<TableDescription | null>(null);
  const [ddl, setDdl] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<SubTab>("columns");

  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<ColumnEdit[]>([]);
  const [plan, setPlan] = useState<AlterPlan | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const t = useT();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [d, s] = await Promise.all([
        api.describeTable(connectionId, table, schema),
        api.showDdl(connectionId, table, schema).catch((e) => {
          // DDL is supplementary — describe + the grid still work without it,
          // so we surface the failure but don't fail the whole load.
          toast.error("Couldn't load DDL", String(e));
          return "";
        }),
      ]);
      setDesc(d);
      setDdl(s);
      setEdits(detailsToEdits(d.columns));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, table, schema]);

  const toggleEdit = () => {
    if (editing) {
      // cancel → restore
      if (desc) setEdits(detailsToEdits(desc.columns));
    }
    setEditing((v) => !v);
  };

  const generate = async () => {
    setApplyError(null);
    try {
      const p = await api.generateAlterDdl(
        connectionId,
        table,
        { columns: edits },
        schema
      );
      setPlan(p);
      setPlanOpen(true);
    } catch (e) {
      setApplyError(String(e));
      setPlan(null);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setApplying(true);
    setApplyError(null);
    try {
      await api.applyAlterDdl(connectionId, plan.statements);
      setPlanOpen(false);
      setEditing(false);
      await load();
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setApplying(false);
    }
  };

  const driverIsSqlite =
    ddl.startsWith("CREATE TABLE") && /\bsqlite_\b/i.test(ddl); // rough hint

  return (
    <div className="flex h-full flex-col">
      <Header
        desc={desc}
        loading={loading}
        editing={editing}
        toggleEdit={toggleEdit}
        onRefresh={() => void load()}
        onGenerate={generate}
        active={active}
        setActive={setActive}
      />
      <div className="min-h-0 flex-1">
        {error ? (
          <ErrorBanner message={error} />
        ) : loading && !desc ? (
          <Loading />
        ) : desc ? (
          <>
            {active === "columns" &&
              (editing ? (
                <ColumnsEditor
                  edits={edits}
                  setEdits={setEdits}
                  sqliteWarn={driverIsSqlite}
                />
              ) : (
                <ColumnsPanel columns={desc.columns} />
              ))}
            {active === "indexes" && <IndexesPanel indexes={desc.indexes} />}
            {active === "fks" && <ForeignKeysPanel fks={desc.foreign_keys} />}
            {active === "ddl" && <DDLPanel ddl={ddl} />}
          </>
        ) : null}
      </div>

      <Modal
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        title={t("design.plan.title")}
        width={720}
        footer={
          <>
            <div className="mr-auto text-[12px] text-muted-foreground">
              {t("table.preview.summary", {
                n: plan?.statements.length ?? 0,
              })}
            </div>
            <Button variant="ghost" onClick={() => setPlanOpen(false)}>
              {t("common.close")}
            </Button>
            <Button
              variant="primary"
              onClick={apply}
              disabled={applying || !plan || plan.statements.length === 0}
            >
              {applying ? t("common.applying") : t("common.apply")}
            </Button>
          </>
        }
      >
        <div className="space-y-2 font-mono text-[12.5px]">
          {plan?.statements.length === 0 && (
            <div className="rounded-md border border-border/70 bg-surface-muted/40 p-3 text-muted-foreground">
              {t("design.plan.none")}
            </div>
          )}
          {plan?.statements.map((s, i) => (
            <pre
              key={i}
              className="overflow-auto rounded-md border border-border/70 bg-surface-muted/40 p-3 text-foreground/90"
            >
              {s};
            </pre>
          ))}
          {plan?.warnings.map((w, i) => (
            <div
              key={i}
              className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[12px] text-warning"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {w}
            </div>
          ))}
          {applyError && (
            <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-danger">
              {applyError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function detailsToEdits(cols: ColumnDetail[]): ColumnEdit[] {
  return cols.map((c) => ({
    original_name: c.name,
    name: c.name,
    data_type: c.data_type,
    nullable: c.nullable,
    default: c.default ?? null,
    is_primary_key: c.is_primary_key,
  }));
}

function Header({
  desc,
  loading,
  editing,
  toggleEdit,
  onRefresh,
  onGenerate,
  active,
  setActive,
}: {
  desc: TableDescription | null;
  loading: boolean;
  editing: boolean;
  toggleEdit: () => void;
  onRefresh: () => void;
  onGenerate: () => void;
  active: SubTab;
  setActive: (s: SubTab) => void;
}) {
  const t = useT();
  return (
    <div className="shrink-0 border-b border-border/70 bg-surface/30">
      <div className="flex items-center gap-3 px-4 pt-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold tracking-tight">
              {desc?.name ?? "…"}
            </span>
            {desc?.schema && (
              <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                {desc.schema}
              </span>
            )}
            {loading && (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
            {editing && (
              <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-brand">
                {t("design.editing")}
              </span>
            )}
          </div>
          {desc?.comment && (
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              {desc.comment}
            </div>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2 text-[11.5px] text-muted-foreground">
          {desc?.row_estimate != null && (
            <Stat label={t("design.stat.rows")} value={formatNumber(desc.row_estimate)} />
          )}
          {desc?.size_bytes != null && (
            <Stat label={t("design.stat.size")} value={formatBytes(desc.size_bytes)} />
          )}
          {desc && <Stat label={t("design.stat.cols")} value={String(desc.columns.length)} />}
          {editing ? (
            <>
              <button
                onClick={toggleEdit}
                className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] hover:bg-accent hover:text-foreground"
              >
                <Undo2 className="h-3.5 w-3.5" />
                {t("common.cancel")}
              </button>
              <button
                onClick={onGenerate}
                className="flex h-7 items-center gap-1 rounded-md bg-brand px-2 text-[12px] font-medium text-brand-foreground hover:bg-brand/90"
              >
                <Check className="h-3.5 w-3.5" />
                {t("design.btn.generate")}
              </button>
            </>
          ) : (
            <button
              onClick={toggleEdit}
              className="flex h-7 items-center gap-1 rounded-md border border-border/70 px-2 text-[12px] hover:bg-accent hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t("design.btn.edit")}
            </button>
          )}
          <button
            onClick={onRefresh}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title={t("common.refresh")}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 px-3">
        <SubTabBtn
          icon={Columns3}
          label={t("design.tab.columns")}
          count={desc?.columns.length}
          active={active === "columns"}
          onClick={() => setActive("columns")}
        />
        <SubTabBtn
          icon={KeyRound}
          label={t("design.tab.indexes")}
          count={desc?.indexes.length}
          active={active === "indexes"}
          onClick={() => setActive("indexes")}
        />
        <SubTabBtn
          icon={Link2}
          label={t("design.tab.fks")}
          count={desc?.foreign_keys.length}
          active={active === "fks"}
          onClick={() => setActive("fks")}
        />
        <SubTabBtn
          icon={ScrollText}
          label={t("design.tab.ddl")}
          active={active === "ddl"}
          onClick={() => setActive("ddl")}
        />
      </div>
    </div>
  );
}

function SubTabBtn({
  icon: Icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "relative flex h-8 items-center gap-1.5 rounded-t-md px-3 text-[12.5px]",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {count != null && (
        <span
          className={cn(
            "rounded-full px-1.5 text-[10.5px] tabular-nums",
            active
              ? "bg-brand/20 text-brand"
              : "bg-surface-muted text-muted-foreground"
          )}
        >
          {count}
        </span>
      )}
      {active && (
        <span className="absolute inset-x-0 bottom-[-1px] h-[2px] rounded bg-brand" />
      )}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="tabular-nums text-foreground/80">{value}</span>
      <span>{label}</span>
    </div>
  );
}

function ColumnsPanel({ columns }: { columns: ColumnDetail[] }) {
  const t = useT();
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <Th>#</Th>
            <Th>{t("design.col.name")}</Th>
            <Th>{t("design.col.type")}</Th>
            <Th>{t("design.col.nullable")}</Th>
            <Th>{t("design.col.default")}</Th>
            <Th>{t("design.col.flags")}</Th>
            <Th>{t("design.col.comment")}</Th>
          </tr>
        </thead>
        <tbody>
          {columns.map((c) => (
            <tr key={c.name} className="group hover:bg-accent/30">
              <Td className="w-10 text-right text-[11px] text-muted-foreground">
                {c.ordinal_position}
              </Td>
              <Td>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-medium">{c.name}</span>
                  {c.is_primary_key && <Pill tone="brand">PK</Pill>}
                </div>
              </Td>
              <Td>
                <span className="font-mono text-sky-300">{formatType(c)}</span>
              </Td>
              <Td>
                {c.nullable ? (
                  <span className="text-muted-foreground">NULL</span>
                ) : (
                  <span className="text-amber-400">NOT NULL</span>
                )}
              </Td>
              <Td>
                <span className="font-mono text-muted-foreground">
                  {c.default ?? "—"}
                </span>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {c.is_auto_increment && <Pill tone="success">auto</Pill>}
                </div>
              </Td>
              <Td className="text-muted-foreground">{c.comment ?? ""}</Td>
            </tr>
          ))}
          {columns.length === 0 && (
            <tr>
              <td colSpan={7} className="py-10 text-center text-muted-foreground">
                {t("design.columns.none")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ColumnsEditor({
  edits,
  setEdits,
  sqliteWarn,
}: {
  edits: ColumnEdit[];
  setEdits: (e: ColumnEdit[]) => void;
  sqliteWarn: boolean;
}) {
  const t = useT();
  const update = (idx: number, patch: Partial<ColumnEdit>) => {
    setEdits(edits.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };
  const remove = (idx: number) => setEdits(edits.filter((_, i) => i !== idx));
  const restore = (idx: number) => {
    // restore original name if we changed it within this session, else no-op
    const e = edits[idx];
    if (e.original_name && e.original_name !== e.name) {
      update(idx, { name: e.original_name });
    }
  };
  const addRow = () =>
    setEdits([
      ...edits,
      {
        original_name: null,
        name: `col_${edits.length + 1}`,
        data_type: "text",
        nullable: true,
        default: null,
        is_primary_key: false,
      },
    ]);

  return (
    <div className="h-full overflow-auto">
      {sqliteWarn && (
        <div className="mx-4 mt-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[12px] text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t("design.edit.sqlite_warn")}
        </div>
      )}
      <table className="w-full border-separate border-spacing-0 text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <Th>#</Th>
            <Th>{t("design.col.name")}</Th>
            <Th>{t("design.col.type")}</Th>
            <Th>{t("design.col.nullable")}</Th>
            <Th>{t("design.col.default")}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {edits.map((e, i) => {
            const isNew = !e.original_name;
            const renamed = e.original_name && e.original_name !== e.name;
            return (
              <tr
                key={i}
                className={cn(
                  "hover:bg-accent/30",
                  isNew && "bg-emerald-500/5",
                  renamed && !isNew && "bg-amber-500/5"
                )}
              >
                <Td className="w-10 text-right text-[11px] text-muted-foreground">
                  {i + 1}
                </Td>
                <Td>
                  <input
                    value={e.name}
                    onChange={(ev) => update(i, { name: ev.target.value })}
                    className="h-7 w-full rounded border border-border/70 bg-surface px-2 font-mono text-[12.5px] focus:border-brand/60 focus:outline-none"
                  />
                  {renamed && (
                    <div className="mt-0.5 text-[10px] text-muted-foreground">
                      {t("design.edit.was")}: <span className="font-mono">{e.original_name}</span>
                    </div>
                  )}
                </Td>
                <Td>
                  <input
                    value={e.data_type}
                    onChange={(ev) =>
                      update(i, { data_type: ev.target.value })
                    }
                    className="h-7 w-full rounded border border-border/70 bg-surface px-2 font-mono text-[12.5px] text-sky-300 focus:border-brand/60 focus:outline-none"
                  />
                </Td>
                <Td>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
                    <input
                      type="checkbox"
                      checked={e.nullable}
                      onChange={(ev) =>
                        update(i, { nullable: ev.target.checked })
                      }
                      className="h-3.5 w-3.5 accent-brand"
                    />
                    {e.nullable ? t("design.col.nullable") : "NOT NULL"}
                  </label>
                </Td>
                <Td>
                  <input
                    value={e.default ?? ""}
                    onChange={(ev) =>
                      update(i, {
                        default: ev.target.value === "" ? null : ev.target.value,
                      })
                    }
                    placeholder="—"
                    className="h-7 w-full rounded border border-border/70 bg-surface px-2 font-mono text-[12.5px] focus:border-brand/60 focus:outline-none"
                  />
                </Td>
                <Td className="w-20">
                  <div className="flex items-center gap-0.5">
                    {renamed && (
                      <button
                        onClick={() => restore(i)}
                        title={t("design.edit.restore_name")}
                        className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <RotateCcw className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      onClick={() => remove(i)}
                      title={isNew ? t("common.delete") : t("design.edit.drop_column")}
                      className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-danger/15 hover:text-danger"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </Td>
              </tr>
            );
          })}
          <tr>
            <td colSpan={6} className="p-2">
              <button
                onClick={addRow}
                className="flex h-7 items-center gap-1.5 rounded-md border border-dashed border-border px-2 text-[12px] text-muted-foreground hover:border-brand/60 hover:bg-accent/40 hover:text-foreground"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("design.edit.add_column")}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function IndexesPanel({ indexes }: { indexes: IndexInfo[] }) {
  const t = useT();
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <Th>{t("design.col.name")}</Th>
            <Th>{t("design.col.columns")}</Th>
            <Th>{t("design.col.unique")}</Th>
            <Th>{t("design.col.primary")}</Th>
            <Th>{t("design.col.method")}</Th>
          </tr>
        </thead>
        <tbody>
          {indexes.map((i) => (
            <tr key={i.name} className="hover:bg-accent/30">
              <Td>
                <span className="font-mono">{i.name}</span>
              </Td>
              <Td>
                <span className="font-mono">{i.columns.join(", ")}</span>
              </Td>
              <Td>{i.is_unique ? <Pill tone="brand">unique</Pill> : "—"}</Td>
              <Td>{i.is_primary ? <Pill tone="brand">PK</Pill> : "—"}</Td>
              <Td className="text-muted-foreground">{i.method ?? "—"}</Td>
            </tr>
          ))}
          {indexes.length === 0 && (
            <tr>
              <td colSpan={5} className="py-10 text-center text-muted-foreground">
                {t("design.indexes.none")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ForeignKeysPanel({ fks }: { fks: ForeignKey[] }) {
  const t = useT();
  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-[12.5px]">
        <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur">
          <tr className="text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <Th>{t("design.col.name")}</Th>
            <Th>{t("design.col.columns")}</Th>
            <Th>{t("design.col.references")}</Th>
            <Th>{t("design.col.on_update")}</Th>
            <Th>{t("design.col.on_delete")}</Th>
          </tr>
        </thead>
        <tbody>
          {fks.map((f) => (
            <tr key={f.name} className="hover:bg-accent/30">
              <Td>
                <span className="font-mono">{f.name}</span>
              </Td>
              <Td>
                <span className="font-mono">{f.columns.join(", ")}</span>
              </Td>
              <Td>
                <span className="font-mono">
                  {f.referenced_schema ? `${f.referenced_schema}.` : ""}
                  {f.referenced_table}
                </span>
                <span className="text-muted-foreground">
                  {" "}
                  ({f.referenced_columns.join(", ")})
                </span>
              </Td>
              <Td className="text-muted-foreground">{f.on_update ?? "—"}</Td>
              <Td className="text-muted-foreground">{f.on_delete ?? "—"}</Td>
            </tr>
          ))}
          {fks.length === 0 && (
            <tr>
              <td colSpan={5} className="py-10 text-center text-muted-foreground">
                {t("design.fks.none")}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DDLPanel({ ddl }: { ddl: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyText(ddl);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="relative h-full">
      <button
        onClick={copy}
        className="absolute right-3 top-3 z-10 flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-surface-elevated/80 px-2 text-[12px] hover:bg-accent"
      >
        <Clipboard className="h-3.5 w-3.5" />
        {copied ? t("common.copied") : t("common.copy")}
      </button>
      <ReadOnlySql value={ddl || "-- (no DDL available)"} />
    </div>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th className="border-b border-border/70 bg-surface/95 px-3 py-2 font-medium">
      {children}
    </th>
  );
}

function Td({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={cn("border-b border-border/50 px-3 py-1.5", className)}>
      {children}
    </td>
  );
}

function Pill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "brand" | "success" | "warning";
}) {
  const toneMap = {
    brand: "bg-brand/20 text-brand",
    success: "bg-emerald-500/15 text-emerald-300",
    warning: "bg-amber-500/15 text-amber-300",
  };
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider",
        toneMap[tone]
      )}
    >
      {children}
    </span>
  );
}

function formatType(c: ColumnDetail): string {
  const t = c.data_type;
  if (
    /char|text|varchar|string/i.test(t) &&
    c.char_max_length != null &&
    c.char_max_length > 0
  ) {
    return `${t}(${c.char_max_length})`;
  }
  if (/numeric|decimal/i.test(t) && c.numeric_precision != null) {
    return c.numeric_scale != null
      ? `${t}(${c.numeric_precision},${c.numeric_scale})`
      : `${t}(${c.numeric_precision})`;
  }
  return t;
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}

function ErrorBanner({ message }: { message: string }) {
  const t = useT();
  return (
    <div className="flex h-full items-start justify-center p-6">
      <div className="max-w-lg rounded-lg border border-danger/40 bg-danger/10 p-4 text-[12.5px]">
        <div className="mb-1 flex items-center gap-2 font-medium text-danger">
          <AlertTriangle className="h-4 w-4" />
          {t("design.err")}
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-foreground/90">
          {message}
        </pre>
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div className="space-y-1 p-4">
      {Array.from({ length: 10 }).map((_, i) => (
        <div
          key={i}
          className="h-6 animate-pulse rounded bg-surface-muted/50"
          style={{ opacity: 1 - i * 0.07 }}
        />
      ))}
    </div>
  );
}
