import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, FileUp, LockKeyhole } from "lucide-react";
import type { ConnectionConfig, NavicatImportPreview } from "@/types";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { cn } from "@/lib/cn";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { toast } from "@/store/toasts";
import { DriverBadge } from "./driverIcon";

function fingerprint(connection: ConnectionConfig): string {
  return JSON.stringify([
    connection.driver,
    connection.name.trim().toLocaleLowerCase(),
    connection.host?.trim().toLocaleLowerCase() ?? "",
    connection.port ?? null,
    connection.database?.trim().toLocaleLowerCase() ?? "",
    connection.username?.trim().toLocaleLowerCase() ?? "",
    connection.file_path?.trim() ?? "",
  ]);
}

function endpoint(connection: ConnectionConfig): string {
  if (connection.driver === "sqlite") {
    return connection.file_path || "—";
  }
  const address = [connection.host || "localhost", connection.port]
    .filter((part) => part != null && part !== "")
    .join(":");
  return connection.database ? `${address} / ${connection.database}` : address;
}

export function NavicatImportDialog({
  open,
  preview,
  fileName,
  onClose,
}: {
  open: boolean;
  preview: NavicatImportPreview | null;
  fileName: string;
  onClose: () => void;
}) {
  const list = useConnections((state) => state.list);
  const save = useConnections((state) => state.save);
  const t = useT();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initializedPreview = useRef<NavicatImportPreview | null>(null);

  const existing = useMemo(
    () => new Set(list.map(fingerprint)),
    [list]
  );
  const duplicateIndices = useMemo(() => {
    const duplicates = new Set<number>();
    const candidates = new Set(existing);
    for (const [index, connection] of (preview?.connections ?? []).entries()) {
      const key = fingerprint(connection);
      if (candidates.has(key)) duplicates.add(index);
      else candidates.add(key);
    }
    return duplicates;
  }, [existing, preview]);

  useEffect(() => {
    if (!open) {
      initializedPreview.current = null;
      return;
    }
    if (!preview || initializedPreview.current === preview) return;
    initializedPreview.current = preview;
    setSelected(
      new Set(
        preview.connections
          .map((_, index) => index)
          .filter((index) => !duplicateIndices.has(index))
      )
    );
    setError(null);
    setImporting(false);
  }, [duplicateIndices, open, preview]);

  const toggle = (index: number) => {
    if (duplicateIndices.has(index)) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const importSelected = async () => {
    if (!preview || selected.size === 0) return;
    setImporting(true);
    setError(null);
    let imported = 0;
    try {
      for (const index of Array.from(selected).sort((a, b) => a - b)) {
        const connection = preview.connections[index];
        await save({ ...connection, id: "", password: null });
        imported += 1;
        setSelected((current) => {
          const next = new Set(current);
          next.delete(index);
          return next;
        });
      }
      toast.success(t("conn.navicat.done", { n: imported }));
      onClose();
    } catch (cause) {
      setError(
        t("conn.navicat.partial_error", {
          imported,
          error: String(cause),
        })
      );
    } finally {
      setImporting(false);
    }
  };

  const warnings = preview
    ? [
        preview.password_count + preview.ssh_password_count > 0
          ? t("conn.navicat.password_warning", {
              n: preview.password_count + preview.ssh_password_count,
            })
          : t("conn.navicat.password_notice"),
        preview.unsupported_types.length > 0
          ? t("conn.navicat.unsupported", {
              types: preview.unsupported_types.join(", "),
            })
          : null,
        preview.http_tunnel_count > 0
          ? t("conn.navicat.http_warning", { n: preview.http_tunnel_count })
          : null,
        preview.unsupported_ssl_count > 0
          ? t("conn.navicat.ssl_warning", { n: preview.unsupported_ssl_count })
          : null,
      ].filter((warning): warning is string => Boolean(warning))
    : [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={importing}
      title={t("conn.navicat.title")}
      closeLabel={t("common.close")}
      width={640}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <span className="text-[12px] text-muted-foreground">
            {preview
              ? t("conn.navicat.selected", {
                  selected: selected.size,
                  total: preview.connections.length,
                })
              : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose} disabled={importing}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void importSelected()}
              disabled={importing || selected.size === 0}
            >
              {importing ? t("common.importing") : t("conn.navicat.import")}
            </Button>
          </div>
        </div>
      }
    >
      {preview && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 rounded-md border border-border/70 bg-surface-muted/30 px-3 py-2 text-[12px] text-muted-foreground">
            <FileUp className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate font-mono">{fileName}</span>
            <span>{t("conn.navicat.found", { n: preview.source_count })}</span>
          </div>

          {warnings.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-warning/30 bg-warning/10 px-3 py-2.5">
              {warnings.map((warning, index) => (
                <div key={index} className="flex items-start gap-2 text-[11.5px] text-muted-foreground">
                  {index === 0 ? (
                    <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  )}
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}

          {preview.connections.length === 0 ? (
            <div className="rounded-md border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground">
              {t("conn.navicat.empty")}
            </div>
          ) : (
            <div className="max-h-[360px] space-y-1 overflow-auto rounded-md border border-border/70 p-1.5">
              {preview.connections.map((connection, index) => {
                const duplicate = duplicateIndices.has(index);
                const checked = selected.has(index);
                return (
                  <button
                    key={`${fingerprint(connection)}:${index}`}
                    type="button"
                    onClick={() => toggle(index)}
                    disabled={duplicate}
                    aria-pressed={checked}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                      checked ? "bg-brand/10" : "hover:bg-accent/60",
                      duplicate && "cursor-not-allowed opacity-45"
                    )}
                  >
                    <span
                      className={cn(
                        "grid h-4 w-4 shrink-0 place-items-center rounded border",
                        checked
                          ? "border-brand bg-brand text-brand-foreground"
                          : "border-border bg-surface"
                      )}
                      aria-hidden="true"
                    >
                      {checked && <Check className="h-3 w-3" />}
                    </span>
                    <DriverBadge driver={connection.driver} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12.5px] font-medium text-foreground">
                        {connection.name}
                      </span>
                      <span className="block truncate font-mono text-[10.5px] text-muted-foreground">
                        {endpoint(connection)}
                      </span>
                    </span>
                    {duplicate && (
                      <span className="shrink-0 text-[10.5px] text-muted-foreground">
                        {t("conn.navicat.duplicate")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
