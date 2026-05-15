import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { api } from "@/lib/api";
import type {
  ColumnInfo,
  CsvPreview,
  ImportMode,
  ImportReport,
} from "@/types";
import { cn } from "@/lib/cn";
import { useT } from "@/store/i18n";

interface Props {
  open: boolean;
  connectionId: string;
  table: string;
  schema?: string;
  onClose: () => void;
}

export function ImportDialog({
  open,
  connectionId,
  table,
  schema,
  onClose,
}: Props) {
  const [path, setPath] = useState("");
  const [delimiter, setDelimiter] = useState(",");
  const [hasHeader, setHasHeader] = useState(true);
  const [mode, setMode] = useState<ImportMode>("append");
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setReport(null);
    setError(null);
    setPreview(null);
    setPath("");
    setMapping([]);
    void (async () => {
      try {
        const cols = await api.listColumns(connectionId, table, schema);
        setColumns(cols);
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [open, connectionId, table, schema]);

  useEffect(() => {
    if (!path) {
      setPreview(null);
      return;
    }
    let alive = true;
    setPreviewing(true);
    setError(null);
    api
      .previewCsv(path, delimiter, hasHeader, 5)
      .then((p) => {
        if (!alive) return;
        setPreview(p);
        // auto-map by name if headers present
        if (p.headers && columns.length > 0) {
          const m = p.headers.map((h) =>
            columns.find(
              (c) => c.name.toLowerCase() === h.toLowerCase()
            )?.name ?? "-"
          );
          setMapping(m);
        } else if (!p.headers) {
          // unmapped: first N columns in order
          setMapping(columns.slice(0, p.sample_rows[0]?.length ?? 0).map((c) => c.name));
        }
      })
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setPreviewing(false));
    return () => {
      alive = false;
    };
  }, [path, delimiter, hasHeader, columns]);

  const pickPath = async () => {
    const picked = await openDialog({
      filters: [{ name: "CSV", extensions: ["csv", "tsv", "txt"] }],
    });
    if (typeof picked === "string") setPath(picked);
  };

  const csvColCount = preview?.sample_rows[0]?.length ?? 0;

  const run = async () => {
    if (!path) {
      setError(t("import.err.path"));
      return;
    }
    if (mapping.every((c) => c === "-")) {
      setError(t("import.err.map"));
      return;
    }
    setRunning(true);
    setError(null);
    setReport(null);
    try {
      const r = await api.importCsv(connectionId, {
        path,
        schema: schema ?? null,
        table,
        delimiter,
        has_header: hasHeader,
        mode,
        column_map: mapping.map((m) => (m === "-" ? "" : m)),
      });
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
      title={t("import.title", {
        target: `${schema ? schema + "." : ""}${table}`,
      })}
      width={720}
      footer={
        <>
          <div className="mr-auto flex items-center gap-2 text-[12px]">
            {running && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("common.importing")}
              </span>
            )}
            {report && (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("import.done.summary", {
                  inserted: report.rows_inserted.toLocaleString(),
                  read: report.rows_read.toLocaleString(),
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
          <Button
            variant="primary"
            onClick={run}
            disabled={running || !preview}
          >
            <FileUp className="h-3.5 w-3.5" />
            {t("import.btn.import")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label required>{t("import.file")}</Label>
          <div className="flex gap-2">
            <Input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={t("import.file.placeholder")}
            />
            <Button onClick={pickPath}>
              <FolderOpen className="h-3.5 w-3.5" />
              {t("common.browse")}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
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
          <div>
            <Label>{t("import.first_row")}</Label>
            <Select
              value={hasHeader ? "yes" : "no"}
              onChange={(e) => setHasHeader(e.target.value === "yes")}
            >
              <option value="yes">{t("import.first_row.header")}</option>
              <option value="no">{t("import.first_row.data")}</option>
            </Select>
          </div>
          <div>
            <Label>{t("import.mode")}</Label>
            <Select
              value={mode}
              onChange={(e) => setMode(e.target.value as ImportMode)}
            >
              <option value="append">{t("import.mode.append")}</option>
              <option value="truncate_insert">{t("import.mode.truncate")}</option>
            </Select>
          </div>
        </div>

        {mode === "truncate_insert" && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[12px] text-warning">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("import.truncate_warn", { table })}
          </div>
        )}

        <div>
          <Label>{t("import.mapping")}</Label>
          {previewing ? (
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("import.mapping.reading")}
            </div>
          ) : !preview ? (
            <div className="text-[12px] text-muted-foreground">
              {t("import.mapping.pick_file")}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border/70">
              <table className="w-full border-collapse text-[12.5px]">
                <thead className="bg-surface-muted/60">
                  <tr className="text-left text-[10.5px] uppercase tracking-wider text-muted-foreground">
                    <th className="w-10 px-2 py-1.5">#</th>
                    <th className="px-2 py-1.5">{t("import.mapping.csv_column")}</th>
                    <th className="px-2 py-1.5">{t("import.mapping.sample")}</th>
                    <th className="px-2 py-1.5">{t("import.mapping.target")}</th>
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: csvColCount }).map((_, i) => {
                    const head = preview.headers?.[i] ?? `col_${i + 1}`;
                    const sample = preview.sample_rows
                      .map((r) => r[i])
                      .filter((v) => v != null && v !== "")
                      .slice(0, 2)
                      .join(" · ");
                    return (
                      <tr key={i} className="border-t border-border/60">
                        <td className="px-2 py-1 text-right text-[11px] text-muted-foreground">
                          {i + 1}
                        </td>
                        <td className="px-2 py-1 font-mono">{head}</td>
                        <td className="px-2 py-1 font-mono text-muted-foreground/80 truncate max-w-[180px]">
                          {sample}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={mapping[i] ?? "-"}
                            onChange={(e) => {
                              const m = mapping.slice();
                              m[i] = e.target.value;
                              setMapping(m);
                            }}
                            className={cn(
                              "h-7 w-full rounded border border-border/70 bg-surface px-1.5 text-[12px]",
                              "focus:border-brand/60 focus:outline-none"
                            )}
                          >
                            <option value="-">{t("import.mapping.skip")}</option>
                            {columns.map((c) => (
                              <option key={c.name} value={c.name}>
                                {c.name}
                                {c.is_primary_key ? " · PK" : ""}
                                {!c.nullable ? " · !null" : ""}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {report && report.errors.length > 0 && (
          <div className="max-h-36 overflow-auto rounded-md border border-border/70 bg-surface-muted/40 p-2 text-[11.5px]">
            <div className="mb-1 font-medium text-warning">
              {t("import.errors", { n: report.errors.length })}
            </div>
            <ul className="space-y-0.5 font-mono text-foreground/80">
              {report.errors.slice(0, 50).map((err, i) => (
                <li key={i} className="truncate">
                  {err}
                </li>
              ))}
              {report.errors.length > 50 && (
                <li className="text-muted-foreground">
                  {t("import.errors.more", { n: report.errors.length - 50 })}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
