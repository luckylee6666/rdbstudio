import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Loader2,
  Sparkles,
  Wand2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { api } from "@/lib/api";
import type {
  ColumnDetail,
  ColumnGeneratorConfig,
  DataGenPreview,
  DataGenReport,
  DataGenRule,
} from "@/types";
import { useT } from "@/store/i18n";

export function inferColumnGeneratorConfig(
  col: ColumnDetail
): ColumnGeneratorConfig {
  const name = col.name.toLowerCase();
  const dtype = col.data_type.toLowerCase();
  const defaultNullPct = col.nullable && !col.is_primary_key ? 10 : 0;

  if (col.is_auto_increment || col.is_identity) {
    return {
      column: col.name,
      rule: "skip",
      null_percent: 0,
    };
  }

  if (col.is_primary_key) {
    if (dtype.includes("uuid") || name.includes("uuid")) {
      return { column: col.name, rule: "uuid", null_percent: 0 };
    }
    if (dtype.includes("int") || dtype.includes("serial")) {
      return {
        column: col.name,
        rule: "sequence",
        null_percent: 0,
        start: 1000,
        step: 1,
      };
    }
    return { column: col.name, rule: "uuid", null_percent: 0 };
  }

  if (name.includes("email") || name.endsWith("_mail") || name === "mail") {
    return { column: col.name, rule: "email", null_percent: defaultNullPct };
  }
  if (name.includes("phone") || name.includes("mobile") || name === "tel") {
    return { column: col.name, rule: "phone", null_percent: defaultNullPct };
  }
  if (
    name === "name" ||
    name.endsWith("_name") ||
    name === "author" ||
    name === "username"
  ) {
    return {
      column: col.name,
      rule: "full_name",
      null_percent: defaultNullPct,
    };
  }
  if (dtype.includes("uuid") || name.includes("uuid") || name.endsWith("_guid")) {
    return { column: col.name, rule: "uuid", null_percent: defaultNullPct };
  }
  if (
    name === "status" ||
    name === "state" ||
    name === "role" ||
    name === "stage"
  ) {
    return {
      column: col.name,
      rule: "enum_list",
      null_percent: defaultNullPct,
      values: "active,pending,archived",
    };
  }
  if (dtype.includes("bool")) {
    return { column: col.name, rule: "boolean", null_percent: defaultNullPct };
  }
  if (dtype.includes("timestamp") || dtype.includes("datetime")) {
    return {
      column: col.name,
      rule: "timestamp_now",
      null_percent: defaultNullPct,
    };
  }
  if (dtype.includes("date")) {
    return {
      column: col.name,
      rule: "date_range",
      null_percent: defaultNullPct,
    };
  }
  if (
    dtype.includes("float") ||
    dtype.includes("double") ||
    dtype.includes("real") ||
    dtype.includes("numeric") ||
    dtype.includes("decimal")
  ) {
    return {
      column: col.name,
      rule: "random_float",
      null_percent: defaultNullPct,
      min: 1,
      max: 1000,
    };
  }
  if (dtype.includes("int")) {
    return {
      column: col.name,
      rule: "random_int",
      null_percent: defaultNullPct,
      min: 1,
      max: 1000,
    };
  }
  return {
    column: col.name,
    rule: "random_text",
    null_percent: defaultNullPct,
  };
}

interface Props {
  open: boolean;
  connectionId: string;
  table: string;
  schema?: string;
  onClose: () => void;
  onGenerated?: () => void;
}

export function DataGeneratorDialog({
  open,
  connectionId,
  table,
  schema,
  onClose,
  onGenerated,
}: Props) {
  const [rowCount, setRowCount] = useState(100);
  const [truncateFirst, setTruncateFirst] = useState(false);
  const [seed, setSeed] = useState("42");
  const [colDetails, setColDetails] = useState<ColumnDetail[]>([]);
  const [configs, setConfigs] = useState<ColumnGeneratorConfig[]>([]);
  const [preview, setPreview] = useState<DataGenPreview | null>(null);
  const [loadingCols, setLoadingCols] = useState(false);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<DataGenReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open || !connectionId || !table) return;
    setReport(null);
    setError(null);
    setPreview(null);
    setTruncateFirst(false);
    setLoadingCols(true);
    void api
      .describeTable(connectionId, table, schema)
      .then((desc) => {
        setColDetails(desc.columns);
        setConfigs(desc.columns.map(inferColumnGeneratorConfig));
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoadingCols(false));
  }, [open, connectionId, table, schema]);

  const updateConfig = (
    idx: number,
    patch: Partial<ColumnGeneratorConfig>
  ) => {
    setConfigs((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, ...patch } : c))
    );
  };

  const buildOptions = () => {
    const parsedSeed = seed.trim() ? Number(seed.trim()) : null;
    return {
      schema: schema ?? null,
      table,
      row_count: Math.max(1, Math.min(100_000, Number(rowCount) || 100)),
      truncate_first: truncateFirst,
      seed:
        parsedSeed != null && Number.isFinite(parsedSeed) ? parsedSeed : null,
      columns: configs,
    };
  };

  const runPreview = async () => {
    setError(null);
    try {
      const p = await api.previewGeneratedData(buildOptions(), 5);
      setPreview(p);
    } catch (e) {
      setError(String(e));
    }
  };

  const runGenerate = async () => {
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const r = await api.generateTableData(connectionId, buildOptions());
      setReport(r);
      onGenerated?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={running}
      title={t("datagen.title", {
        target: `${schema ? schema + "." : ""}${table}`,
      })}
      width={780}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-[12px]">
            {running && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("datagen.running")}
              </span>
            )}
            {report && (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("datagen.done", {
                  rows: report.rows_inserted.toLocaleString(),
                  ms: report.elapsed_ms,
                })}
              </span>
            )}
            {error && (
              <span className="flex items-center gap-1.5 text-danger">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="max-w-[380px] truncate">{error}</span>
              </span>
            )}
          </div>
          <Button
            variant="ghost"
            onClick={() => void runPreview()}
            disabled={running || loadingCols || configs.length === 0}
          >
            <Eye className="h-3.5 w-3.5" />
            {t("datagen.btn.preview")}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            {report ? t("common.done") : t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() => void runGenerate()}
            disabled={running || loadingCols || configs.length === 0}
          >
            <Wand2 className="h-3.5 w-3.5" />
            {t("datagen.btn.generate")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[140px_140px_1fr_auto] items-end gap-3">
          <div>
            <Label>{t("datagen.rows")}</Label>
            <Input
              type="number"
              min={1}
              max={100000}
              value={rowCount}
              onChange={(e) => setRowCount(Number(e.target.value) || 1)}
            />
          </div>
          <div>
            <Label>{t("datagen.seed")}</Label>
            <Input
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="42"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-[12.5px]">
            <input
              type="checkbox"
              checked={truncateFirst}
              onChange={(e) => setTruncateFirst(e.target.checked)}
              className="h-3.5 w-3.5 accent-brand"
            />
            <span>{t("datagen.truncate_first")}</span>
          </label>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              setConfigs(colDetails.map(inferColumnGeneratorConfig))
            }
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("datagen.auto_infer")}
          </Button>
        </div>

        <div className="rounded-lg border border-border/70 bg-surface-muted/20">
          <div className="grid grid-cols-[180px_170px_1fr_80px] gap-2 border-b border-border/70 bg-surface-muted/50 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>{t("datagen.col.column")}</span>
            <span>{t("datagen.col.rule")}</span>
            <span>{t("datagen.col.params")}</span>
            <span>{t("datagen.col.null_pct")}</span>
          </div>
          <div className="max-h-64 divide-y divide-border/50 overflow-y-auto">
            {loadingCols ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[12px] text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : (
              configs.map((cfg, idx) => {
                const detail = colDetails[idx];
                return (
                  <div
                    key={cfg.column}
                    className="grid grid-cols-[180px_170px_1fr_80px] items-center gap-2 px-3 py-1.5 text-[12px]"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono font-medium">
                        {cfg.column}
                      </div>
                      <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                        {detail?.data_type}
                        {detail?.is_primary_key ? " · PK" : ""}
                      </div>
                    </div>
                    <Select
                      value={cfg.rule}
                      onChange={(e) =>
                        updateConfig(idx, {
                          rule: e.target.value as DataGenRule,
                        })
                      }
                    >
                      <option value="skip">{t("datagen.rule.skip")}</option>
                      <option value="sequence">
                        {t("datagen.rule.sequence")}
                      </option>
                      <option value="random_int">
                        {t("datagen.rule.random_int")}
                      </option>
                      <option value="random_float">
                        {t("datagen.rule.random_float")}
                      </option>
                      <option value="boolean">
                        {t("datagen.rule.boolean")}
                      </option>
                      <option value="uuid">{t("datagen.rule.uuid")}</option>
                      <option value="full_name">
                        {t("datagen.rule.full_name")}
                      </option>
                      <option value="email">{t("datagen.rule.email")}</option>
                      <option value="phone">{t("datagen.rule.phone")}</option>
                      <option value="random_text">
                        {t("datagen.rule.random_text")}
                      </option>
                      <option value="enum_list">
                        {t("datagen.rule.enum_list")}
                      </option>
                      <option value="date_range">
                        {t("datagen.rule.date_range")}
                      </option>
                      <option value="timestamp_now">
                        {t("datagen.rule.timestamp_now")}
                      </option>
                      <option value="null">{t("datagen.rule.null")}</option>
                    </Select>

                    <div className="flex items-center gap-1.5">
                      {cfg.rule === "sequence" && (
                        <>
                          <Input
                            type="number"
                            value={cfg.start ?? 1}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              updateConfig(idx, {
                                start: Number.isFinite(n) ? n : 1,
                              });
                            }}
                            placeholder="Start"
                          />
                          <Input
                            type="number"
                            value={cfg.step ?? 1}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              updateConfig(idx, {
                                step: Number.isFinite(n) && n !== 0 ? n : 1,
                              });
                            }}
                            placeholder="Step"
                          />
                        </>
                      )}
                      {(cfg.rule === "random_int" ||
                        cfg.rule === "random_float") && (
                        <>
                          <Input
                            type="number"
                            value={cfg.min ?? 1}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              updateConfig(idx, {
                                min: Number.isFinite(n) ? n : 0,
                              });
                            }}
                            placeholder="Min"
                          />
                          <Input
                            type="number"
                            value={cfg.max ?? 1000}
                            onChange={(e) => {
                              const n = Number(e.target.value);
                              updateConfig(idx, {
                                max: Number.isFinite(n) ? n : 1000,
                              });
                            }}
                            placeholder="Max"
                          />
                        </>
                      )}
                      {cfg.rule === "enum_list" && (
                        <Input
                          value={cfg.values ?? "active,pending,archived"}
                          onChange={(e) =>
                            updateConfig(idx, { values: e.target.value })
                          }
                          placeholder="a,b,c"
                        />
                      )}
                    </div>

                    <Input
                      type="number"
                      min={0}
                      max={100}
                      disabled={
                        !detail?.nullable ||
                        cfg.rule === "skip" ||
                        cfg.rule === "null"
                      }
                      value={cfg.null_percent ?? 0}
                      onChange={(e) =>
                        updateConfig(idx, {
                          null_percent: Math.max(
                            0,
                            Math.min(100, Number(e.target.value) || 0)
                          ),
                        })
                      }
                    />
                  </div>
                );
              })
            )}
          </div>
        </div>

        {preview && (
          <div className="space-y-1.5">
            <div className="text-[11.5px] font-medium text-muted-foreground">
              {t("datagen.preview_title", { n: preview.rows.length })}
            </div>
            <div className="max-h-40 overflow-auto rounded-lg border border-border/70">
              <table className="w-full text-left font-mono text-[11.5px]">
                <thead className="bg-surface-muted text-muted-foreground">
                  <tr>
                    {preview.columns.map((c) => (
                      <th key={c} className="px-2.5 py-1 font-medium">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {preview.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((cell, j) => (
                        <td
                          key={j}
                          className="max-w-[180px] truncate px-2.5 py-1"
                        >
                          {cell === null ? (
                            <span className="italic text-muted-foreground">
                              NULL
                            </span>
                          ) : (
                            String(cell)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
