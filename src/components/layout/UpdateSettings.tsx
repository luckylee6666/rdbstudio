import { useEffect, useRef, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { invoke } from "@tauri-apps/api/core";
import { Download, Loader2, RefreshCw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useT } from "@/store/i18n";

export function UpdateSettings() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [available, setAvailable] = useState<string | null>(null);
  const [installed, setInstalled] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const update = useRef<Update | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    // StrictMode runs effect setup, cleanup, then setup again in development.
    // Restore the mounted guard on each setup so subsequent checks still update UI.
    mounted.current = true;
    return () => {
      mounted.current = false;
      void update.current?.close().catch(() => {});
    };
  }, []);

  const checkNow = async () => {
    setBusy(true);
    setMessage("");
    setAvailable(null);
    try {
      await update.current?.close();
      update.current = await check();
      if (!mounted.current) {
        await update.current?.close();
        return;
      }
      setAvailable(update.current?.version ?? null);
      setMessage(
        update.current
          ? t("update.available", { version: update.current.version })
          : t("update.latest")
      );
    } catch (error) {
      if (mounted.current) setMessage(`${t("update.check_failed")}: ${String(error)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const install = async () => {
    if (!update.current) return;
    setBusy(true);
    setProgress(0);
    let downloaded = 0;
    let total: number | undefined;
    try {
      await update.current.downloadAndInstall((event) => {
        if (!mounted.current) return;
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        setProgress(total ? Math.min(100, Math.floor((downloaded / total) * 100)) : null);
      });
      if (mounted.current) {
        setInstalled(true);
        setMessage(t("update.installed"));
      }
    } catch (error) {
      if (mounted.current) setMessage(String(error));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 py-1">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{t("update.title")}</div>
          <p role="status" className="break-words text-[11.5px] text-muted-foreground">
            {message || t("update.hint")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {installed ? (
            <Button variant="primary" onClick={() => void invoke("restart_application")}>
              <RotateCw className="h-3.5 w-3.5" />
              {t("update.restart")}
            </Button>
          ) : available ? (
            <Button variant="primary" disabled={busy} onClick={() => setConfirm(true)}>
              <Download className="h-3.5 w-3.5" />
              {t("update.install")}
            </Button>
          ) : null}
          <Button disabled={busy} onClick={() => void checkNow()}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t("update.check")}
          </Button>
        </div>
      </div>
      {busy && progress != null && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label={t("update.progress")}>
            <div className="h-full rounded-full bg-brand transition-[width]" style={{ width: `${progress}%` }} />
          </div>
          <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{progress}%</span>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void install()}
        title={t("update.install")}
        message={t("update.install_confirm")}
        confirmLabel={t("update.install")}
        cancelLabel={t("common.cancel")}
      />
    </div>
  );
}
