import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { redisTools, type RedisStreamGroup } from "@/lib/redisTools";
import { useRedisToolsT } from "./redisToolsI18n";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function RedisStreamTools({ connectionId, redisKey, readOnly = false, onChanged }: { connectionId: string; redisKey: string; readOnly?: boolean; onChanged: () => Promise<void> }) {
  const t = useRedisToolsT();
  const [groups, setGroups] = useState<RedisStreamGroup[]>([]);
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [entryDraft, setEntryDraft] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshGroups = useCallback(async () => {
    setBusy(true);
    setError(null);
    try { setGroups(await redisTools.xinfoGroups(connectionId, redisKey)); }
    catch (cause) { setError(`${t("operationFailed")}: ${String(cause)}`); }
    finally { setBusy(false); }
  }, [connectionId, redisKey, t]);

  useEffect(() => {
    if (groupsOpen) void refreshGroups();
  }, [groupsOpen, refreshGroups]);

  const addEntry = async () => {
    const fields = entryDraft.split(/\r?\n/).map((line) => {
      const separator = line.indexOf("=");
      return separator < 1 ? null : [line.slice(0, separator).trim(), line.slice(separator + 1)] as [string, string];
    });
    if (!fields.length || fields.some((item) => item == null || !item[0]) || fields.length > 64) { setError(t("invalidEntry")); return; }
    setBusy(true); setError(null);
    try {
      await redisTools.xadd(connectionId, redisKey, fields as Array<[string, string]>);
      setEntryDraft(""); await onChanged();
    } catch (cause) { setError(`${t("operationFailed")}: ${String(cause)}`); }
    finally { setBusy(false); }
  };

  const createGroup = async () => {
    if (!groupName.trim()) { setError(t("invalidGroup")); return; }
    setBusy(true); setError(null);
    try {
      await redisTools.xgroupCreate(connectionId, redisKey, groupName.trim());
      setGroupName(""); await refreshGroups();
    } catch (cause) { setError(`${t("operationFailed")}: ${String(cause)}`); }
    finally { setBusy(false); }
  };

  const deleteGroup = async () => {
    if (!pendingDelete) return;
    const name = pendingDelete; setPendingDelete(null); setBusy(true); setError(null);
    try { await redisTools.xgroupDestroy(connectionId, redisKey, name); await refreshGroups(); }
    catch (cause) { setError(`${t("operationFailed")}: ${String(cause)}`); }
    finally { setBusy(false); }
  };

  return <div className="flex flex-wrap items-start gap-3 border-b border-border/60 bg-surface/35 px-3 py-2">
    <div className="flex min-w-[260px] flex-1 flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[11px] text-muted-foreground">{t("addEntry")}</span>
      <textarea value={entryDraft} onChange={(e) => setEntryDraft(e.target.value)} disabled={readOnly} placeholder={`${t("fieldName")}=${t("fieldValue")}\n…`} rows={2} className="min-w-[160px] flex-1 resize-y rounded border border-border bg-background px-2 py-1 text-[11px] font-mono disabled:opacity-50" />
      <button onClick={() => void addEntry()} disabled={busy || readOnly} title={t("addEntry")} className="grid h-6 w-6 place-items-center rounded bg-brand/15 text-brand disabled:opacity-50"><Plus className="h-3.5 w-3.5" /></button>
    </div>
    <div className="flex min-w-[250px] flex-1 flex-wrap items-center gap-1.5">
      <button onClick={() => setGroupsOpen((open) => !open)} className="rounded border border-border px-2 py-1 text-[11px]">{t("groups")}</button>
      {groupsOpen && <>
        <input value={groupName} onChange={(e) => setGroupName(e.target.value)} disabled={readOnly} placeholder={t("groupName")} className="w-28 rounded border border-border bg-background px-2 py-1 text-[11px] disabled:opacity-50" />
        <button onClick={() => void createGroup()} disabled={busy || readOnly} title={t("createGroup")} className="grid h-6 w-6 place-items-center rounded bg-brand/15 text-brand disabled:opacity-50"><Plus className="h-3.5 w-3.5" /></button>
        <button onClick={() => void refreshGroups()} disabled={busy} title={t("refreshGroups")} className="grid h-6 w-6 place-items-center rounded hover:bg-accent disabled:opacity-50">{busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}</button>
      </>}
    </div>
    {groupsOpen && <div className="basis-full space-y-1">
      {groups.length === 0 && <span className="text-[11px] text-muted-foreground">{t("noGroups")}</span>}
      {groups.map((group) => <div key={group.name} className="flex items-center gap-2 rounded bg-background px-2 py-1 text-[11px]">
        <span className="min-w-0 flex-1 truncate font-mono">{group.name}</span><span className="text-muted-foreground">{group.consumers} {t("consumers")} · {group.pending} {t("pending")}</span>
        <button onClick={() => setPendingDelete(group.name)} disabled={readOnly} title={t("stop")} className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-danger/10 hover:text-danger disabled:opacity-40"><Trash2 className="h-3 w-3" /></button>
      </div>)}
    </div>}
    {error && <div role="alert" className="basis-full text-[11px] text-danger">{error}</div>}
    <ConfirmDialog open={pendingDelete != null} title={t("groups")} message={t("confirmDeleteGroup", { name: pendingDelete ?? "" })} confirmLabel={t("stop")} cancelLabel={t("cancel")} danger onConfirm={() => void deleteGroup()} onClose={() => setPendingDelete(null)} />
  </div>;
}
