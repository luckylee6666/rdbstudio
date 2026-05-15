import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  FileDown,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { api } from "@/lib/api";
import type { ExportFormat, ExportReport } from "@/types";
import { useT } from "@/store/i18n";

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
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ExportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setReport(null);
    setError(null);
    setPath("");
  }, [open]);

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
                  <option value="\t">{t("export.delim.tab")}</option>
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
          <p className="text-[12px] text-muted-foreground">
            {t("export.sql_note")}
          </p>
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
