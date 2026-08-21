import { useEffect, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  FolderOpen,
  Loader2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { api, type DumpReport } from "@/lib/api";
import { useT } from "@/store/i18n";
import type { DriverKind } from "@/types";

interface Props {
  open: boolean;
  connectionId: string;
  driver: DriverKind;
  database: string;
  onClose: () => void;
}

type ExportContent = "structure_data" | "structure_only";

export function DatabaseExportDialog({
  open,
  connectionId,
  driver,
  database,
  onClose,
}: Props) {
  const [content, setContent] = useState<ExportContent>("structure_data");
  const [path, setPath] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<DumpReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setContent("structure_data");
    setPath("");
    setReport(null);
    setError(null);
  }, [open, database]);

  const fileExtension =
    driver === "sqlite" && content === "structure_data" ? "db" : "sql";

  const pickPath = async () => {
    const picked = await saveDialog({
      defaultPath: `${safeFileName(database)}.${fileExtension}`,
      filters: [
        fileExtension === "db"
          ? { name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }
          : { name: "SQL", extensions: ["sql"] },
      ],
    });
    if (typeof picked === "string") setPath(picked);
  };

  const run = async () => {
    if (!path) {
      setError(t("export.err.path"));
      return;
    }
    setRunning(true);
    setReport(null);
    setError(null);
    try {
      const result = await api.dumpDatabase(
        connectionId,
        path,
        database,
        content === "structure_only"
      );
      setReport(result);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={running}
      title={
        driver === "postgres"
          ? t("database_export.title_schema", { schema: database })
          : t("database_export.title", { database })
      }
      width={540}
      footer={
        <>
          <div className="mr-auto flex min-w-0 items-center gap-2 text-[12px]">
            {running && (
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("common.exporting")}
              </span>
            )}
            {report && (
              <span className="flex items-center gap-1.5 text-success">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t("database_export.done", {
                  bytes: formatBytes(report.bytes),
                  ms: report.elapsed_ms,
                })}
              </span>
            )}
            {error && (
              <span className="flex min-w-0 items-center gap-1.5 text-danger">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{error}</span>
              </span>
            )}
          </div>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            {report ? t("common.done") : t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={run} disabled={running}>
            <DatabaseBackup className="h-3.5 w-3.5" />
            {t("export.btn.export")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>{t("database_export.content")}</Label>
          <Select
            value={content}
            onChange={(event) => {
              setContent(event.target.value as ExportContent);
              setPath("");
            }}
          >
            <option value="structure_data">
              {t("export.sql.structure_data")}
            </option>
            <option value="structure_only">
              {t("export.sql.structure_only")}
            </option>
          </Select>
        </div>

        <div>
          <Label required>{t("export.destination")}</Label>
          <div className="flex gap-2">
            <Input
              value={path}
              onChange={(event) => setPath(event.target.value)}
              placeholder={t("export.destination.placeholder")}
            />
            <Button onClick={pickPath}>
              <FolderOpen className="h-3.5 w-3.5" />
              {t("common.browse")}
            </Button>
          </div>
        </div>

        <p className="rounded-lg border border-border/70 bg-surface-muted/30 p-3 text-[12px] leading-relaxed text-muted-foreground">
          {driver === "sqlite" && content === "structure_data"
            ? t("database_export.note.sqlite_snapshot")
            : t(`database_export.note.${content}`)}
        </p>
      </div>
    </Modal>
  );
}

function safeFileName(value: string): string {
  return value.replace(/[^\w.-]+/g, "_") || "database";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[index]}`;
}
