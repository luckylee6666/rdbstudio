import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  FolderOpen,
  Loader2,
  Square,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Field";
import { DbIoProgress } from "./DbIoProgress";
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
  const [operationId, setOperationId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const activeOperationRef = useRef<string | null>(null);
  const cancelRequestedOperationRef = useRef<string | null>(null);
  const [report, setReport] = useState<DumpReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  useEffect(() => {
    if (!open) return;
    setContent("structure_data");
    setPath("");
    setReport(null);
    setError(null);
    setCancelPending(false);
    setCancelRequested(false);
    activeOperationRef.current = null;
    cancelRequestedOperationRef.current = null;
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
    const id = crypto.randomUUID();
    activeOperationRef.current = id;
    cancelRequestedOperationRef.current = null;
    setOperationId(id);
    setRunning(true);
    setCancelPending(false);
    setCancelRequested(false);
    setReport(null);
    setError(null);
    try {
      const result = await api.dumpDatabase(
        connectionId,
        path,
        database,
        content === "structure_only",
        id
      );
      if (activeOperationRef.current === id) setReport(result);
    } catch (cause) {
      if (activeOperationRef.current === id) {
        setError(
          cancelRequestedOperationRef.current === id &&
            isCancellationError(cause)
            ? t("database_export.cancelled")
            : String(cause)
        );
      }
    } finally {
      if (activeOperationRef.current === id) {
        activeOperationRef.current = null;
        cancelRequestedOperationRef.current = null;
        setRunning(false);
        setOperationId(null);
        setCancelPending(false);
        setCancelRequested(false);
      }
    }
  };

  const cancel = async () => {
    const id = operationId;
    if (!id || activeOperationRef.current !== id || cancelPending || cancelRequested) return;
    setCancelPending(true);
    setError(null);
    try {
      const found = await invoke<boolean>("cancel_db_io", { operationId: id });
      if (activeOperationRef.current !== id) return;
      if (found) {
        cancelRequestedOperationRef.current = id;
        setCancelRequested(true);
      } else setError(t("database_export.cancel_unavailable"));
    } catch (cause) {
      if (activeOperationRef.current === id) setError(String(cause));
    } finally {
      if (activeOperationRef.current === id) setCancelPending(false);
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
            {running && <DbIoProgress operationId={operationId} />}
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
          {running ? (
            <Button
              variant="danger"
              onClick={cancel}
              disabled={cancelPending || cancelRequested}
            >
              {cancelPending || cancelRequested ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {cancelPending || cancelRequested
                ? t("database_export.canceling")
                : t("database_export.cancel")}
            </Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              {report ? t("common.done") : t("common.cancel")}
            </Button>
          )}
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

function isCancellationError(error: unknown): boolean {
  return /\b(cancelled|canceled)\b/i.test(String(error));
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
