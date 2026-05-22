import { useMemo, useState } from "react";
import { AlertTriangle, KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useT } from "@/store/i18n";
import type { DriverKind } from "@/types";

interface ColumnDraft {
  id: number;
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  autoIncrement: boolean;
  defaultValue: string;
}

const TYPE_OPTIONS: Record<DriverKind, string[]> = {
  mysql: [
    "INT", "BIGINT", "TINYINT", "SMALLINT",
    "DECIMAL(10,2)", "FLOAT", "DOUBLE",
    "VARCHAR(255)", "CHAR(36)", "TEXT", "LONGTEXT",
    "DATE", "DATETIME", "TIMESTAMP", "TIME",
    "BOOLEAN", "JSON", "BLOB",
  ],
  postgres: [
    "INTEGER", "BIGINT", "SMALLINT",
    "NUMERIC(10,2)", "REAL", "DOUBLE PRECISION",
    "TEXT", "VARCHAR(255)", "CHAR(36)",
    "DATE", "TIMESTAMPTZ", "TIMESTAMP", "TIME",
    "BOOLEAN", "JSONB", "JSON", "UUID", "BYTEA",
  ],
  sqlite: [
    "INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC",
  ],
  redis: [],
};

let nextColId = 1;
const blankColumn = (): ColumnDraft => ({
  id: nextColId++,
  name: "",
  type: "",
  notNull: false,
  primaryKey: false,
  autoIncrement: false,
  defaultValue: "",
});

function quoteIdent(driver: DriverKind, name: string): string {
  if (driver === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  // postgres + sqlite both accept double-quoted identifiers
  return `"${name.replace(/"/g, '""')}"`;
}

function quoteStringLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

// Heuristic: if the default looks like a number, a SQL function call, or one
// of NULL/TRUE/FALSE/CURRENT_TIMESTAMP/DEFAULT, pass it through; otherwise
// treat it as a string literal and quote it.
function formatDefault(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  const upper = v.toUpperCase();
  if (
    upper === "NULL" ||
    upper === "TRUE" ||
    upper === "FALSE" ||
    upper === "CURRENT_TIMESTAMP" ||
    upper === "CURRENT_DATE" ||
    upper === "CURRENT_TIME" ||
    upper === "NOW()"
  ) {
    return upper;
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (/^[A-Za-z_][\w]*\s*\(.*\)$/.test(v)) return v; // function call
  return quoteStringLiteral(v);
}

interface BuildResult {
  sql: string;
  error: string | null;
}

function buildSql(
  driver: DriverKind,
  schema: string | undefined,
  tableName: string,
  columns: ColumnDraft[]
): BuildResult {
  const name = tableName.trim();
  if (!name) return { sql: "", error: "Table name is required" };
  const cols = columns.filter((c) => c.name.trim() && c.type.trim());
  if (cols.length === 0)
    return { sql: "", error: "At least one column is required" };

  const seen = new Set<string>();
  for (const c of cols) {
    const lc = c.name.trim().toLowerCase();
    if (seen.has(lc)) return { sql: "", error: `Duplicate column: ${c.name}` };
    seen.add(lc);
  }

  const pkCols = cols.filter((c) => c.primaryKey);
  const qualified =
    schema && driver !== "sqlite"
      ? `${quoteIdent(driver, schema)}.${quoteIdent(driver, name)}`
      : quoteIdent(driver, name);

  const colLines = cols.map((c) => {
    const parts: string[] = [quoteIdent(driver, c.name.trim())];
    let typeStr = c.type.trim();

    // Auto-increment: emit driver-specific type/keyword.
    if (c.autoIncrement) {
      if (driver === "postgres") {
        typeStr = typeStr.toUpperCase().includes("BIG") ? "BIGSERIAL" : "SERIAL";
      } else if (driver === "sqlite") {
        // SQLite: only INTEGER PRIMARY KEY supports AUTOINCREMENT, and the
        // AUTOINCREMENT keyword must follow PRIMARY KEY on the same column.
        typeStr = "INTEGER";
      }
    }
    parts.push(typeStr);

    if (c.notNull && !c.primaryKey) parts.push("NOT NULL");
    if (c.defaultValue.trim()) {
      const def = formatDefault(c.defaultValue);
      if (def) parts.push(`DEFAULT ${def}`);
    }

    // mysql/sqlite write AUTO_INCREMENT/AUTOINCREMENT inline; postgres handles
    // it via the SERIAL pseudo-type above.
    if (c.autoIncrement) {
      if (driver === "mysql") parts.push("AUTO_INCREMENT");
      if (driver === "sqlite" && c.primaryKey && pkCols.length === 1)
        parts.push("PRIMARY KEY AUTOINCREMENT");
    }

    // Inline PK only when it's a single-column PK (and we haven't already
    // emitted PRIMARY KEY via the sqlite autoinc branch above).
    if (
      c.primaryKey &&
      pkCols.length === 1 &&
      !(driver === "sqlite" && c.autoIncrement)
    ) {
      parts.push("PRIMARY KEY");
    }

    return "  " + parts.join(" ");
  });

  // Multi-column PK constraint at the table level.
  if (pkCols.length > 1) {
    const pkList = pkCols
      .map((c) => quoteIdent(driver, c.name.trim()))
      .join(", ");
    colLines.push(`  PRIMARY KEY (${pkList})`);
  }

  let sql = `CREATE TABLE ${qualified} (\n${colLines.join(",\n")}\n)`;
  if (driver === "mysql") sql += " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
  sql += ";";
  return { sql, error: null };
}

export function CreateTableDialog({
  open,
  connectionId,
  driver,
  schema,
  onClose,
  onCreated,
}: {
  open: boolean;
  connectionId: string;
  driver: DriverKind;
  schema?: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const t = useT();
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState<ColumnDraft[]>(() => {
    const id = { ...blankColumn(), name: "id", type: driver === "postgres" ? "BIGINT" : driver === "mysql" ? "BIGINT" : "INTEGER", primaryKey: true, autoIncrement: true, notNull: true };
    return [id, { ...blankColumn(), name: "name", type: driver === "sqlite" ? "TEXT" : "VARCHAR(255)" }];
  });
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const { sql, error: buildError } = useMemo(
    () => buildSql(driver, schema, tableName, columns),
    [driver, schema, tableName, columns]
  );

  const reset = () => {
    setTableName("");
    setColumns([
      { ...blankColumn(), name: "id", type: driver === "postgres" ? "BIGINT" : driver === "mysql" ? "BIGINT" : "INTEGER", primaryKey: true, autoIncrement: true, notNull: true },
      { ...blankColumn(), name: "name", type: driver === "sqlite" ? "TEXT" : "VARCHAR(255)" },
    ]);
    setSubmitError(null);
  };

  const handleClose = () => {
    if (saving) return;
    reset();
    onClose();
  };

  const submit = async () => {
    if (!sql) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await api.executeQuery(connectionId, sql);
      onCreated();
      reset();
      onClose();
    } catch (e) {
      setSubmitError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const updateCol = (id: number, patch: Partial<ColumnDraft>) => {
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  };

  const removeCol = (id: number) => {
    setColumns((cs) => (cs.length <= 1 ? cs : cs.filter((c) => c.id !== id)));
  };

  const addCol = () => {
    setColumns((cs) => [...cs, blankColumn()]);
  };

  const typeOptions = TYPE_OPTIONS[driver] ?? [];

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("create.table.title")}
      width={780}
      footer={
        <div className="flex w-full flex-col gap-2">
          {(buildError || submitError) && (
            <div className="flex items-start gap-1.5 text-[12px] text-danger">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">
                {submitError ?? buildError}
              </span>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={handleClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={saving || !!buildError || !sql}
            >
              {saving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("common.saving")}
                </>
              ) : (
                t("create.table.submit")
              )}
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_180px] gap-3">
          <div>
            <Label required>{t("create.table.name")}</Label>
            <Input
              autoFocus
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder="my_table"
            />
          </div>
          <div>
            <Label>{t("create.table.schema")}</Label>
            <Input value={schema ?? "—"} disabled />
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label>{t("create.table.columns")}</Label>
            <button
              type="button"
              onClick={addCol}
              className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("create.table.add_column")}
            </button>
          </div>

          <div className="overflow-hidden rounded-md border border-border/60">
            <table className="w-full border-collapse text-[12px]">
              <thead className="bg-surface/60 text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t("create.table.col.name")}
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t("create.table.col.type")}
                  </th>
                  <th className="px-2 py-1.5 text-center font-medium" title={t("create.table.col.not_null")}>
                    NN
                  </th>
                  <th className="px-2 py-1.5 text-center font-medium" title={t("create.table.col.primary")}>
                    PK
                  </th>
                  <th className="px-2 py-1.5 text-center font-medium" title={t("create.table.col.auto_inc")}>
                    AI
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t("create.table.col.default")}
                  </th>
                  <th className="w-7 px-1 py-1.5"></th>
                </tr>
              </thead>
              <tbody>
                {columns.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t border-border/40 align-top"
                  >
                    <td className="px-1.5 py-1">
                      <input
                        value={c.name}
                        onChange={(e) =>
                          updateCol(c.id, { name: e.target.value })
                        }
                        placeholder="col_name"
                        className="w-full rounded border border-border/50 bg-background px-1.5 py-1 font-mono outline-none focus:border-primary"
                      />
                    </td>
                    <td className="px-1.5 py-1">
                      <div className="flex gap-1">
                        <input
                          value={c.type}
                          onChange={(e) =>
                            updateCol(c.id, { type: e.target.value })
                          }
                          placeholder="TYPE"
                          className="min-w-0 flex-1 rounded border border-border/50 bg-background px-1.5 py-1 font-mono outline-none focus:border-primary"
                        />
                        <select
                          value=""
                          onChange={(e) => {
                            if (e.target.value)
                              updateCol(c.id, { type: e.target.value });
                          }}
                          className="w-7 shrink-0 rounded border border-border/50 bg-background px-0 text-[10px] outline-none focus:border-primary"
                          title="Pick from presets"
                        >
                          <option value="">▾</option>
                          {typeOptions.map((opt) => (
                            <option key={opt} value={opt}>
                              {opt}
                            </option>
                          ))}
                        </select>
                      </div>
                    </td>
                    <td className="px-1.5 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={c.notNull}
                        onChange={(e) =>
                          updateCol(c.id, { notNull: e.target.checked })
                        }
                      />
                    </td>
                    <td className="px-1.5 py-1 text-center">
                      <label className="inline-flex items-center justify-center">
                        <input
                          type="checkbox"
                          checked={c.primaryKey}
                          onChange={(e) =>
                            updateCol(c.id, {
                              primaryKey: e.target.checked,
                              // PK columns are implicitly NOT NULL; reflect it
                              // in the checkbox so users see the constraint.
                              notNull: e.target.checked || c.notNull,
                            })
                          }
                        />
                        {c.primaryKey && (
                          <KeyRound className="ml-1 h-3 w-3 text-amber-400" />
                        )}
                      </label>
                    </td>
                    <td className="px-1.5 py-1 text-center">
                      <input
                        type="checkbox"
                        checked={c.autoIncrement}
                        onChange={(e) =>
                          updateCol(c.id, { autoIncrement: e.target.checked })
                        }
                        disabled={driver === "sqlite" && !c.primaryKey}
                        title={
                          driver === "sqlite" && !c.primaryKey
                            ? "SQLite AUTOINCREMENT requires PRIMARY KEY"
                            : undefined
                        }
                      />
                    </td>
                    <td className="px-1.5 py-1">
                      <input
                        value={c.defaultValue}
                        onChange={(e) =>
                          updateCol(c.id, { defaultValue: e.target.value })
                        }
                        placeholder="NULL · 0 · 'x' · NOW()"
                        className="w-full rounded border border-border/50 bg-background px-1.5 py-1 font-mono outline-none focus:border-primary"
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => removeCol(c.id)}
                        disabled={columns.length <= 1}
                        className={cn(
                          "grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-danger/15 hover:text-danger",
                          columns.length <= 1 && "opacity-30 hover:bg-transparent hover:text-muted-foreground"
                        )}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <Label>{t("create.table.preview")}</Label>
          <pre className="max-h-[200px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-border/60 bg-surface/40 p-2 font-mono text-[11.5px] text-foreground/85">
            {sql || "—"}
          </pre>
        </div>
      </div>
    </Modal>
  );
}
