import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  FileDown,
  FolderOpen,
  Loader2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { api } from "@/lib/api";
import type { ColumnInfo, ExportFormat, ExportReport, MaskKind } from "@/types";
import { useT } from "@/store/i18n";

export function autoDetectMaskKind(columnName: string): MaskKind | null {
  const lower = columnName.toLowerCase();
  if (lower.includes("email") || lower.endsWith("_mail") || lower === "mail") {
    return "email";
  }
  if (
    lower.includes("phone") ||
    lower.includes("mobile") ||
    lower === "tel" ||
    lower.endsWith("_tel")
  ) {
    return "phone";
  }
  if (
    lower.includes("password") ||
    lower.includes("passwd") ||
    lower.includes("secret") ||
    lower.includes("token") ||
    lower.includes("api_key")
  ) {
    return "redact";
  }
  if (
    lower.includes("ssn") ||
    lower.includes("id_card") ||
    lower.includes("card_no") ||
    lower.includes("card_number") ||
    lower.includes("iban")
  ) {
    return "partial";
  }
  if (
    lower === "name" ||
    lower === "full_name" ||
    lower === "real_name" ||
    lower === "first_name" ||
    lower === "last_name"
  ) {
    return "name";
  }
  return null;
}

interface Props {
  open: boolean;
  connectionId: string;
  table: string;
  schema?: string;
  onClose: () => void;
}

export function ExportDialog({
  open,
  connectionId,
  table,
  schema,
  onClose,
}: Props) {
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [path, setPath] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [header, setHeader] = useState(true);
  const [quoteAll, setQuoteAll] = useState(false);
  const [sqlContent, setSqlContent] = useState<
    "structure_data" | "structure_only" | "data_only"
  >("structure_data");
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [columnMasks, setColumnMasks] = useState<Record<string, MaskKind>>({});
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setReport(null);
    setError(null);
    setPath("");
    setColumnMasks({});
    if (connectionId && table) {
      void api
        .listColumns(connectionId, table, schema)
        .then((cols) => setColumns(Array.isArray(cols) ? cols : []))
        .catch(() => setColumns([]));
    } else {
      setColumns([]);
    }
  }, [open, connectionId, table, schema]);

  const setMask = (col: string, kind: MaskKind | "") => {
    setColumnMasks((prev) => {
      const next = { ...prev };
      if (!kind) {
        delete next[col];
      } else {
        next[col] = kind;
      }
      return next;
    });
  };

  const applyAutoDetectMasks = () => {
    const next: Record<string, MaskKind> = { ...columnMasks };
    for (const c of columns) {
      const detected = autoDetectMaskKind(c.name);
      if (detected) next[c.name] = detected;
    }
    setColumnMasks(next);
  };

  const pickPath = async () => {
    const ext = format === "csv" ? "csv" : format === "json" ? "json" : "sql";
    const picked = await saveDialog({
      defaultPath: `${table}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (typeof picked === "string") setPath(picked);
  };

  const run = async () => {
    if (!path) {
      setError(t("export.err.path"));
      return;
    }
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const r = await api.exportTable(
        connectionId,
        table,
        {
          format,
          path,
          delimiter,
          include_header: header,
          quote_all: quoteAll,
          include_ddl: sqlContent !== "data_only",
          include_data: sqlContent !== "structure_only",
          column_masks:
            Object.keys(columnMasks).length > 0 ? columnMasks : undefined,
        },
        schema
      );
      setReport(r);
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
      title={t("export.title", {
        target: `${schema ? schema + "." : ""}${table}`,
      })}
      width={560}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-[12px]">
            {running && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("common.exporting")}
              </span>
            )}
            {report && (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("export.done.summary", {
                  rows: report.rows_written.toLocaleString(),
                  bytes: formatBytes(report.bytes),
                  ms: report.elapsed_ms,
                })}
              </span>
            )}
            {error && (
              <span className="flex items-center gap-1.5 text-danger">
                <AlertTriangle className="h-3.5 w-3.5" />
                <span className="max-w-[320px] truncate">{error}</span>
              </span>
            )}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            {report ? t("common.done") : t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={run} disabled={running}>
            <FileDown className="h-3.5 w-3.5" />
            {t("export.btn.export")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[140px_1fr] items-end gap-3">
          <div>
            <Label>{t("export.format")}</Label>
            <Select
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportFormat)}
            >
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
              <option value="sql">SQL INSERTs</option>
            </Select>
          </div>
          <div>
            <Label required>{t("export.destination")}</Label>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={t("export.destination.placeholder")}
              />
              <Button onClick={pickPath}>
                <FolderOpen className="h-3.5 w-3.5" />
                {t("common.browse")}
              </Button>
            </div>
          </div>
        </div>

        {format === "csv" && (
          <div className="space-y-3 rounded-lg border border-border/70 bg-surface-muted/30 p-3">
            <div className="grid grid-cols-[140px_1fr] items-end gap-3">
              <div>
                <Label>{t("export.delimiter")}</Label>
                <Select
                  value={delimiter}
                  onChange={(e) => setDelimiter(e.target.value)}
                >
                  <option value=",">{t("export.delim.comma")}</option>
                  <option value=";">{t("export.delim.semi")}</option>
                  <option value={"\t"}>{t("export.delim.tab")}</option>
                  <option value="|">{t("export.delim.pipe")}</option>
                </Select>
              </div>
              <div className="flex items-center gap-4 pb-2 text-[12.5px]">
                <Check
                  label={t("export.include_header")}
                  checked={header}
                  onChange={setHeader}
                />
                <Check
                  label={t("export.quote_all")}
                  checked={quoteAll}
                  onChange={setQuoteAll}
                />
              </div>
            </div>
          </div>
        )}

        {format === "sql" && (
          <div className="space-y-3 rounded-lg border border-border/70 bg-surface-muted/30 p-3">
            <div>
              <Label>{t("export.sql_content")}</Label>
              <Select
                value={sqlContent}
                onChange={(event) =>
                  setSqlContent(
                    event.target.value as
                      | "structure_data"
                      | "structure_only"
                      | "data_only"
                  )
                }
              >
                <option value="structure_data">
                  {t("export.sql.structure_data")}
                </option>
                <option value="structure_only">
                  {t("export.sql.structure_only")}
                </option>
                <option value="data_only">{t("export.sql.data_only")}</option>
              </Select>
            </div>
            <p className="text-[12px] text-muted-foreground">
              {t(`export.sql_note.${sqlContent}`)}
            </p>
          </div>
        )}

        {columns.length > 0 &&
          !(format === "sql" && sqlContent === "structure_only") && (
            <div className="space-y-2.5 rounded-lg border border-border/70 bg-surface-muted/30 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
                  <ShieldAlert className="h-3.5 w-3.5 text-brand" />
                  <span>{t("export.mask.title")}</span>
                  {Object.keys(columnMasks).length > 0 && (
                    <span className="rounded bg-brand/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-brand">
                      {Object.keys(columnMasks).length}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={applyAutoDetectMasks}
                  >
                    <Sparkles className="h-3 w-3" />
                    {t("export.mask.auto_detect")}
                  </Button>
                  {Object.keys(columnMasks).length > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setColumnMasks({})}
                    >
                      {t("export.mask.clear")}
                    </Button>
                  )}
                </div>
              </div>
              <p className="text-[11.5px] text-muted-foreground">
                {t("export.mask.desc")}
              </p>
              <div className="max-h-44 space-y-1.5 overflow-y-auto pr-1">
                {columns.map((c) => {
                  const activeMask = columnMasks[c.name] ?? "";
                  return (
                    <div
                      key={c.name}
                      className="grid grid-cols-[1fr_190px] items-center gap-2 rounded border border-border/50 bg-surface px-2.5 py-1 text-[12px]"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-mono font-medium">
                          {c.name}
                        </span>
                        <span className="truncate font-mono text-[10.5px] text-muted-foreground">
                          {c.data_type}
                        </span>
                      </div>
                      <Select
                        value={activeMask}
                        onChange={(e) =>
                          setMask(c.name, e.target.value as MaskKind | "")
                        }
                      >
                        <option value="">{t("export.mask.none")}</option>
                        <option value="email">{t("export.mask.email")}</option>
                        <option value="phone">{t("export.mask.phone")}</option>
                        <option value="name">{t("export.mask.name")}</option>
                        <option value="partial">
                          {t("export.mask.partial")}
                        </option>
                        <option value="redact">
                          {t("export.mask.redact")}
                        </option>
                        <option value="hash">{t("export.mask.hash")}</option>
                        <option value="null">{t("export.mask.null")}</option>
                      </Select>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
      </div>
    </Modal>
  );
}

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3.5 w-3.5 accent-brand"
      />
      {label}
    </label>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`;
}
