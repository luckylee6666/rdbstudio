import { useMemo, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { asyncPanel } from "@/components/ui/asyncPanel";
import { compileModelDdl } from "@/lib/modelDdl";
import { saveTextFile } from "@/lib/csv";
import { copyText } from "@/lib/clipboard";
import type { ModelRecord } from "@/lib/offlineModel";
import { useT } from "@/store/i18n";
import { useConnections } from "@/store/connections";
import { nextQueryTitle, useWorkspace } from "@/store/workspace";
import { modelControl } from "./ModelEditors";

const ReadOnlySql = asyncPanel(() => import("@/components/editor/ReadOnlySql").then(m => m.ReadOnlySql));

export function ModelDdlDialog({ record, visible, onClose }: { record: ModelRecord; visible: boolean; onClose: () => void }) {
  const t = useT();
  const [createNamespaces, setCreateNamespaces] = useState(false), [connectionId, setConnectionId] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [copied, setCopied] = useState(false);
  const connections = useConnections(s => s.list), status = useConnections(s => s.status);
  const targets = connections.filter(c => c.driver === record.model.dialect && !c.read_only && status[c.id] === "connected");
  const plan = useMemo(() => compileModelDdl(record.model, { createNamespaces }), [record.model, createNamespaces]);
  const action = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(null); try { await work(); } catch { setError(t("model.ddl.action_error")); } finally { setBusy(false); } };
  return <Modal open={visible} title={t("model.ddl.title")} width={960} closeDisabled={busy} onClose={onClose}>
    <div className="space-y-3">
      <p className="text-sm font-medium break-all">{record.name} <span className="text-xs text-muted-foreground">{record.model.dialect.toUpperCase()}</span></p>
      <p className="text-xs text-muted-foreground">{t("model.ddl.help")}</p>
      {record.model.dialect !== "sqlite" && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={createNamespaces} disabled={busy} onChange={e => { setCreateNamespaces(e.target.checked); setCopied(false); }} />{t("model.ddl.namespaces")}</label>}
      {plan.errors.length > 0 && <div role="alert" className="max-h-40 space-y-1 overflow-auto rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{plan.errors.map((issue, i) => <p key={i} className="break-all">{t(`model.ddl.error.${issue.code}`)}{issue.detail && ` · ${issue.detail}`}</p>)}</div>}
      {plan.warnings.length > 0 && <details className="rounded-md border border-border bg-surface-muted/30 p-2 text-xs" open={plan.errors.length > 0}><summary className="cursor-pointer font-medium">{t("model.ddl.notes")} ({plan.warnings.length})</summary><ul className="mt-2 max-h-32 list-disc space-y-1 overflow-auto pl-5 text-muted-foreground">{plan.warnings.map((issue, i) => <li key={i} className="break-words">{t(`model.ddl.warning.${issue.code}`)}{issue.detail && ` · ${issue.detail}`}</li>)}</ul></details>}
      {plan.sql && <div className="h-[36vh] min-h-40 overflow-hidden rounded-md border border-border" aria-label={t("model.ddl.preview")}><ReadOnlySql value={plan.sql} /></div>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-0 flex-1 text-xs">{t("model.ddl.target")}<select aria-label={t("model.ddl.target")} className={modelControl} value={targets.some(c => c.id === connectionId) ? connectionId : ""} disabled={busy} onChange={e => setConnectionId(e.target.value)}><option value="">{t("model.ddl.choose")}</option>{targets.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <Button disabled={busy || !plan.sql || !targets.some(c => c.id === connectionId)} onClick={() => {
          // Hand off a fixed SQL snapshot; only the query editor can execute it.
          useWorkspace.getState().openTab({ id: `query:${crypto.randomUUID()}`, kind: "query", title: nextQueryTitle(), connectionId, sql: plan.sql }); onClose();
        }}>{t("model.ddl.open_editor")}</Button>
      </div>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button disabled={busy} onClick={onClose}>{t("common.close")}</Button><Button disabled={busy || !plan.sql} onClick={() => void action(async () => { if (!await copyText(plan.sql)) throw new Error("clipboard"); setCopied(true); })}>{t(copied ? "model.ddl.copied" : "model.ddl.copy")}</Button><Button disabled={busy || !plan.sql} onClick={() => void action(() => saveTextFile(`${record.name}.sql`, plan.sql, "sql"))}>{t("model.ddl.export")}</Button></div>
    </div>
  </Modal>;
}
