import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Loader2,
  OctagonX,
  RefreshCw,
  Search,
  Server,
  Skull,
} from "lucide-react";
import { api } from "@/lib/api";
import type { ServerMonitorSnapshot, ServerProcess } from "@/types";
import { useConnections } from "@/store/connections";
import { Select, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/store/toasts";
import { useT } from "@/store/i18n";
import { cn } from "@/lib/cn";

export function ServerMonitorView({
  initialConnectionId,
}: {
  initialConnectionId?: string;
}) {
  const { list, status, connect } = useConnections();
  const [connId, setConnId] = useState<string>(() => {
    if (initialConnectionId) return initialConnectionId;
    const connected = list.find((c) => status[c.id] === "connected");
    return connected?.id ?? list[0]?.id ?? "";
  });
  const [snapshot, setSnapshot] = useState<ServerMonitorSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRefreshSec, setAutoRefreshSec] = useState<number>(0);
  const [filter, setFilter] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [killTarget, setKillTarget] = useState<{
    proc: ServerProcess;
    cancelOnly: boolean;
  } | null>(null);
  const t = useT();

  const currentCfg = useMemo(
    () => list.find((c) => c.id === connId) ?? null,
    [list, connId]
  );

  const loadSnapshot = useCallback(
    async (targetId: string) => {
      if (!targetId) return;
      setLoading(true);
      setError(null);
      try {
        if (status[targetId] !== "connected") {
          await connect(targetId);
        }
        const snap = await api.serverMonitorSnapshot(targetId);
        setSnapshot(snap);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [connect, status]
  );

  useEffect(() => {
    if (!connId && list.length > 0) {
      const connected = list.find((c) => status[c.id] === "connected");
      setConnId(connected?.id ?? list[0].id);
      return;
    }
    if (connId) {
      void loadSnapshot(connId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connId, list.length]);

  useEffect(() => {
    if (!connId || autoRefreshSec <= 0) return;
    const timer = window.setInterval(() => {
      void loadSnapshot(connId);
    }, autoRefreshSec * 1000);
    return () => window.clearInterval(timer);
  }, [connId, autoRefreshSec, loadSnapshot]);

  const filteredProcesses = useMemo(() => {
    const procs = snapshot?.processes ?? [];
    const q = filter.trim().toLowerCase();
    return procs.filter((p) => {
      if (activeOnly) {
        const st = (p.state ?? "").toLowerCase();
        const cmd = (p.command ?? "").toLowerCase();
        const isIdle =
          st === "idle" ||
          cmd === "sleep" ||
          st.startsWith("idle in transaction");
        if (isIdle) return false;
      }
      if (!q) return true;
      return (
        p.id.toLowerCase().includes(q) ||
        (p.user ?? "").toLowerCase().includes(q) ||
        (p.database ?? "").toLowerCase().includes(q) ||
        (p.client ?? "").toLowerCase().includes(q) ||
        (p.state ?? "").toLowerCase().includes(q) ||
        (p.query ?? "").toLowerCase().includes(q)
      );
    });
  }, [snapshot, filter, activeOnly]);

  const confirmKill = async () => {
    if (!killTarget || !connId) return;
    const { proc, cancelOnly } = killTarget;
    setKillTarget(null);
    try {
      await api.killServerProcess(connId, proc.id, cancelOnly);
      toast.success(
        cancelOnly
          ? t("monitor.cancel_done", { id: proc.id })
          : t("monitor.kill_done", { id: proc.id })
      );
      await loadSnapshot(connId);
    } catch (e) {
      toast.error(t("monitor.kill_failed"), String(e));
    }
  };

  const supportsCancelQuery =
    currentCfg?.driver === "postgres" || currentCfg?.driver === "mysql";

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/70 bg-surface/30 px-4 py-2.5 text-[12px]">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Activity className="h-4 w-4 text-brand" />
          <span>{t("tool.monitor.title")}</span>
        </div>

        <div className="w-56">
          <Select
            value={connId}
            onChange={(e) => setConnId(e.target.value)}
            aria-label={t("monitor.connection")}
          >
            {list.length === 0 && (
              <option value="">{t("monitor.no_connections")}</option>
            )}
            {list.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.driver})
              </option>
            ))}
          </Select>
        </div>

        <div className="w-44">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("monitor.filter.placeholder")}
          />
        </div>

        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground">
          <input
            type="checkbox"
            checked={activeOnly}
            onChange={(e) => setActiveOnly(e.target.checked)}
            className="h-3.5 w-3.5 accent-brand"
          />
          <span>{t("monitor.active_only")}</span>
        </label>

        <div className="flex-1" />

        <div className="flex items-center gap-1.5">
          <span className="text-[11.5px] text-muted-foreground">
            {t("monitor.auto_refresh")}
          </span>
          <div className="w-24">
            <Select
              value={String(autoRefreshSec)}
              onChange={(e) => setAutoRefreshSec(Number(e.target.value) || 0)}
            >
              <option value="0">{t("monitor.refresh.off")}</option>
              <option value="2">2s</option>
              <option value="5">5s</option>
              <option value="10">10s</option>
            </Select>
          </div>
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => void loadSnapshot(connId)}
          disabled={!connId || loading}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {t("common.refresh")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4 space-y-4">
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}

        {snapshot && (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <div className="rounded-lg border border-border/70 bg-surface-elevated p-3">
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
                  <Server className="h-3 w-3 text-brand" />
                  <span>{t("monitor.server")}</span>
                </div>
                <div
                  className="mt-1 truncate font-mono text-[13px] font-semibold text-foreground"
                  title={snapshot.server_version}
                >
                  {snapshot.server_version}
                </div>
              </div>
              {snapshot.metrics.map((m) => (
                <div
                  key={m.key}
                  className="rounded-lg border border-border/70 bg-surface-elevated p-3"
                >
                  <div className="truncate text-[11px] uppercase tracking-wider text-muted-foreground">
                    {m.label}
                  </div>
                  <div className="mt-1 truncate font-mono text-[15px] font-semibold text-foreground">
                    {m.value}
                  </div>
                </div>
              ))}
            </div>

            <div className="overflow-hidden rounded-lg border border-border/70 bg-surface-elevated">
              <div className="flex items-center justify-between border-b border-border/70 bg-surface-muted/40 px-3 py-2 text-[12px]">
                <div className="flex items-center gap-2 font-medium">
                  <Search className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>
                    {t("monitor.processes.title", {
                      n: filteredProcesses.length,
                    })}
                  </span>
                </div>
                {currentCfg?.read_only && (
                  <span className="text-[11px] text-warning">
                    {t("monitor.read_only_hint")}
                  </span>
                )}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="border-b border-border/70 bg-surface-muted/30 text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2">ID</th>
                      <th className="px-3 py-2">{t("monitor.col.user")}</th>
                      <th className="px-3 py-2">{t("monitor.col.db")}</th>
                      <th className="px-3 py-2">{t("monitor.col.client")}</th>
                      <th className="px-3 py-2">{t("monitor.col.state")}</th>
                      <th className="px-3 py-2">{t("monitor.col.time")}</th>
                      <th className="px-3 py-2">{t("monitor.col.query")}</th>
                      <th className="px-3 py-2 text-right">
                        {t("monitor.col.actions")}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {filteredProcesses.length === 0 ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          {t("monitor.empty")}
                        </td>
                      </tr>
                    ) : (
                      filteredProcesses.map((proc) => {
                        const dur = proc.duration_sec ?? 0;
                        const isSlow = dur >= 5;
                        return (
                          <tr
                            key={proc.id}
                            className="hover:bg-accent/30 transition-colors"
                          >
                            <td className="whitespace-nowrap px-3 py-2 font-mono">
                              <span>{proc.id}</span>
                              {proc.is_self && (
                                <span className="ml-1.5 rounded bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">
                                  {t("monitor.self")}
                                </span>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                              {proc.user ?? "—"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 font-mono">
                              {proc.database ?? "—"}
                            </td>
                            <td className="max-w-[160px] truncate px-3 py-2 font-mono text-muted-foreground">
                              {proc.client ?? "—"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2">
                              <span
                                className={cn(
                                  "inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
                                  proc.state === "active"
                                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                    : "bg-surface-muted text-muted-foreground"
                                )}
                              >
                                {proc.state ?? proc.command ?? "—"}
                              </span>
                              {proc.wait_info && (
                                <span className="ml-1.5 font-mono text-[10.5px] text-warning">
                                  {proc.wait_info}
                                </span>
                              )}
                            </td>
                            <td
                              className={cn(
                                "whitespace-nowrap px-3 py-2 font-mono tabular-nums",
                                isSlow
                                  ? "font-semibold text-warning"
                                  : "text-muted-foreground"
                              )}
                            >
                              {proc.duration_sec != null
                                ? `${proc.duration_sec}s`
                                : "—"}
                            </td>
                            <td
                              className="max-w-[380px] truncate px-3 py-2 font-mono text-[11.5px]"
                              title={proc.query ?? ""}
                            >
                              {proc.query ?? "—"}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-right">
                              <div className="inline-flex items-center gap-1">
                                {supportsCancelQuery && proc.killable && (
                                  <button
                                    disabled={!!currentCfg?.read_only}
                                    onClick={() =>
                                      setKillTarget({ proc, cancelOnly: true })
                                    }
                                    title={t("monitor.btn.cancel_query")}
                                    className="inline-flex h-6 items-center gap-1 rounded border border-border/70 px-2 text-[11px] text-muted-foreground hover:border-warning hover:text-warning disabled:opacity-40"
                                  >
                                    <OctagonX className="h-3 w-3" />
                                    {t("monitor.btn.cancel_query")}
                                  </button>
                                )}
                                {proc.killable && (
                                  <button
                                    disabled={!!currentCfg?.read_only}
                                    onClick={() =>
                                      setKillTarget({ proc, cancelOnly: false })
                                    }
                                    title={t("monitor.btn.kill")}
                                    className="inline-flex h-6 items-center gap-1 rounded border border-danger/40 bg-danger/10 px-2 text-[11px] text-danger hover:bg-danger/20 disabled:opacity-40"
                                  >
                                    <Skull className="h-3 w-3" />
                                    {t("monitor.btn.kill")}
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </div>

      {killTarget && (
        <ConfirmDialog
          open={!!killTarget}
          title={
            killTarget.cancelOnly
              ? t("monitor.confirm.cancel_title")
              : t("monitor.confirm.kill_title")
          }
          message={
            killTarget.cancelOnly
              ? t("monitor.confirm.cancel_msg", { id: killTarget.proc.id })
              : t("monitor.confirm.kill_msg", { id: killTarget.proc.id })
          }
          confirmLabel={
            killTarget.cancelOnly
              ? t("monitor.btn.cancel_query")
              : t("monitor.btn.kill")
          }
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => void confirmKill()}
          onClose={() => setKillTarget(null)}
        />
      )}
    </div>
  );
}
