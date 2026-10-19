import { useEffect, useRef, useState } from "react";
import { CopyPlus, Loader2, Square } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { syncApi } from "@/lib/sync-api";
import { nativeCopy, type NativeCopyPreview, type NativeCopyProgress } from "@/lib/nativeCopy";
import type { SyncPreview } from "@/types/sync";
import { useI18n, useT } from "@/store/i18n";
import { changeLabel } from "@/components/layout/syncI18n";

export function CopyTableDialog({ connectionId, schema, table, onClose, onCopied }: {
  connectionId: string; schema?: string; table: string; onClose: () => void; onCopied: () => void;
}) {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const [name, setName] = useState(`${table}_copy`);
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [mode, setMode] = useState<"native" | "portable">("native");
  const [nativePreview, setNativePreview] = useState<NativeCopyPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<number | null>(null);
  const [operationId, setOperationId] = useState<string | null>(null);
  const [progress, setProgress] = useState<NativeCopyProgress | null>(null);
  const [cancelPending, setCancelPending] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const generation = useRef(0);
  const operation = useRef<string | null>(null);
  const canCopy = mode === "native" ? nativePreview !== null
    : preview && !preview.structure.target_exists && preview.structure.supported && preview.data_supported;
  useEffect(() => {
    generation.current++;
    setName(`${table}_copy`); setPreview(null); setNativePreview(null);
    setBusy(false); setError(""); setDone(null); setOperationId(null);
    setCancelPending(false); setCancelRequested(false);
    return () => {
      generation.current++;
      const active = operation.current;
      operation.current = null;
      if (active) void nativeCopy.cancel(active).catch(() => undefined);
    };
  }, [connectionId, schema, table]);
  useEffect(() => {
    setProgress(null);
    if (!operationId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await nativeCopy.progress(operationId!);
        if (!stopped) setProgress(value);
      } catch { /* The operation may have just finished. */ }
      if (!stopped) timer = setTimeout(() => void poll(), 400);
    }
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [operationId]);
  function invalidate() {
    generation.current++; setPreview(null); setNativePreview(null); setError(""); setDone(null);
  }
  async function inspect() {
    if (!name.trim() || name.trim() === table) {
      setError(t("table_tools.new_name_required")); return;
    }
    const requestGeneration = ++generation.current;
    setBusy(true); setPreview(null); setNativePreview(null); setError(""); setDone(null);
    try {
      if (mode === "native") {
        const next = await nativeCopy.preview(connectionId, table, name.trim(), schema);
        if (requestGeneration === generation.current) setNativePreview(next);
        return;
      }
      const result = await syncApi.preview({
        source_id: connectionId, target_id: connectionId,
        source_schema: schema ?? null, target_schema: schema ?? null,
        source_table: table, target_table: name.trim(), compare_deletes: false,
      });
      if (requestGeneration !== generation.current) return;
      setPreview(result);
      if (result.structure.target_exists) setError(t("table_tools.target_exists"));
      else if (!result.structure.supported || !result.data_supported) {
        setError(result.data_reason || result.structure.reason || t("table_tools.unsupported"));
      }
    } catch (cause) { if (requestGeneration === generation.current) setError(String(cause)); }
    finally { if (requestGeneration === generation.current) setBusy(false); }
  }
  async function copy() {
    if (busy || !canCopy) return;
    const requestGeneration = ++generation.current;
    setBusy(true); setError(""); setCancelRequested(false); setCancelPending(false);
    try {
      let rows: number;
      if (mode === "native" && nativePreview) {
        const id = crypto.randomUUID();
        operation.current = id; setOperationId(id);
        rows = (await nativeCopy.apply(nativePreview.token, id)).rows_copied;
      } else if (preview) rows = (await syncApi.applyData(preview.token, "insert_only", true)).inserted;
      else return;
      if (requestGeneration !== generation.current) return;
      setError(""); setDone(rows); onCopied();
    } catch (cause) { if (requestGeneration === generation.current) setError(String(cause)); }
    finally {
      if (requestGeneration === generation.current) {
        operation.current = null; setOperationId(null); setBusy(false); setPreview(null); setNativePreview(null);
        setCancelPending(false); setCancelRequested(false);
      }
    }
  }
  async function cancel() {
    const id = operation.current;
    if (!id || cancelPending || cancelRequested || progress?.phase === "finishing") return;
    setCancelPending(true);
    try {
      const found = await nativeCopy.cancel(id);
      if (operation.current !== id) return;
      if (found) setCancelRequested(true);
      else setError(t("native_copy.cancel_unavailable"));
    } catch (cause) { if (operation.current === id) setError(String(cause)); }
    finally { if (operation.current === id) setCancelPending(false); }
  }
  const phase = cancelRequested ? "cancelling" : progress?.phase ?? "preparing";
  return <Modal open title={t("table_tools.copy_title", { table })} onClose={onClose} closeDisabled={busy}
    width={640} footer={<>
      {operationId && <Button variant="danger" disabled={cancelPending || cancelRequested || phase === "finishing"} onClick={() => void cancel()}>
        <Square className="h-3 w-3" />{t(cancelPending || cancelRequested ? "native_copy.stopping" : "native_copy.stop")}
      </Button>}
      <Button variant="ghost" onClick={onClose} disabled={busy}>{t("common.close")}</Button>
      <Button disabled={busy || done !== null} onClick={() => void inspect()}>{t("table_tools.preview")}</Button>
      <Button variant="primary" disabled={busy || !canCopy} onClick={() => void copy()}>
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CopyPlus className="h-3.5 w-3.5" />}
        {t("table_tools.copy_confirm")}
      </Button>
    </>}>
    <div className="space-y-4 text-[12px]">
      <label className="block space-y-1.5"><span>{t("native_copy.mode")}</span>
        <Select value={mode} disabled={busy || done !== null} onChange={(event) => { setMode(event.target.value as "native" | "portable"); invalidate(); }}>
          <option value="native">{t("native_copy.native")}</option>
          <option value="portable">{t("native_copy.portable")}</option>
        </Select>
      </label>
      <label className="block space-y-1.5"><span>{t("table_tools.target_name")}</span>
        <Input value={name} disabled={busy || done !== null} onChange={(event) => {
          setName(event.target.value); invalidate();
        }} />
      </label>
      <p className="leading-relaxed text-muted-foreground">{t(mode === "native" ? "native_copy.description" : "table_tools.copy_limits")}</p>
      {mode === "native" && nativePreview && <div className="space-y-2 rounded-md border border-border bg-surface-muted/30 p-3">
        <p>{t("native_copy.snapshot")}</p>
        {nativePreview.plan.warnings.map((warning, index) => <p key={index} className="break-words text-warning">{warning}</p>)}
        <p className="text-muted-foreground">{t(nativePreview.plan.transactional ? "native_copy.transactional" : "native_copy.staged")}</p>
        <details><summary className="cursor-pointer text-muted-foreground">{t("table_tools.sql_preview")}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{nativePreview.plan.statements.join(";\n")}</pre>
        </details>
      </div>}
      {preview && <div className="space-y-2 rounded-md border border-border bg-surface-muted/30 p-3">
        <p>{t("table_tools.copy_rows", { count: preview.counts.inserts })}</p>
        {preview.structure.changes.filter((change) => change.kind.includes("not_copied")).map((change, index) =>
          <p key={index} className="text-warning">{change.name}: {changeLabel(lang, change.kind)}{change.detail ? ` · ${change.detail}` : ""}</p>
        )}
        <p className="text-warning">{t("table_tools.copy_notice")}</p>
        <details><summary className="cursor-pointer text-muted-foreground">{t("table_tools.sql_preview")}</summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px]">{preview.structure.statements.join(";\n")}</pre>
        </details>
      </div>}
      {operationId && <div role="status" className="space-y-2 rounded-md border border-brand/30 bg-brand/5 p-3">
        <div className="flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" />{t(`native_copy.phase.${phase}`)}
          {progress && <span className="ml-auto tabular-nums text-muted-foreground">{(progress.elapsed_ms / 1000).toFixed(1)} s</span>}
        </div>
        <p className="text-muted-foreground">{t("native_copy.no_percent")}</p>
      </div>}
      {error && <p role="alert" className="break-words text-danger">{error}</p>}
      {done !== null && <p role="status" className="text-success">{t("table_tools.copy_done", { name: name.trim(), count: done })}</p>}
    </div>
  </Modal>;
}
