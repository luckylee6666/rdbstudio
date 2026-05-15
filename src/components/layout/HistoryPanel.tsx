import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Search, Trash2 } from "lucide-react";
import { api, type HistoryEntry } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/store/workspace";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function HistoryPanel() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openTab = useWorkspace((s) => s.openTab);
  const connections = useConnections((s) => s.list);
  const t = useT();

  const load = async () => {
    setLoading(true);
    try {
      const es = await api.listHistory(200);
      setEntries(es);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    if (!q.trim()) return entries;
    const needle = q.toLowerCase();
    return entries.filter(
      (e) => e.sql.toLowerCase().includes(needle) || (e.error ?? "").toLowerCase().includes(needle)
    );
  }, [entries, q]);

  const onOpen = (e: HistoryEntry) => {
    openTab({
      id: `query:hist:${e.id}`,
      kind: "query",
      title: "Query",
      subtitle: timeAgo(e.at),
      connectionId: e.connection_id,
    });
    sessionStorage.setItem(`rdb:sql:query:hist:${e.id}`, e.sql);
  };

  const doClear = async () => {
    await api.clearHistory();
    setEntries([]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("sidebar.history")}
        </div>
        <button
          onClick={() => setConfirmOpen(true)}
          title={t("sidebar.clear")}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-2 pb-2">
        <div className="flex h-7 items-center gap-1.5 rounded-md border border-border/70 bg-surface px-2 text-[12px]">
          <Search className="h-3 w-3 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("common.filter")}
            className="flex-1 border-0 bg-transparent outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-1.5 py-6 text-[12px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("common.loading")}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-[12px] text-muted-foreground">
            {entries.length === 0 ? t("sidebar.history.empty") : t("sidebar.history.no_matches")}
          </div>
        ) : (
          <ul className="space-y-0.5 px-2 pb-3">
            {filtered.map((e) => {
              const conn = connections.find((c) => c.id === e.connection_id);
              return (
                <li key={e.id}>
                  <button
                    onDoubleClick={() => onOpen(e)}
                    onClick={() => onOpen(e)}
                    className={cn(
                      "group flex w-full flex-col gap-1 rounded-md border border-transparent px-2 py-1.5 text-left hover:border-border/60 hover:bg-accent/40"
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      {e.error ? (
                        <AlertTriangle className="h-3 w-3 text-danger" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3 text-success" />
                      )}
                      <span className="truncate font-medium text-foreground/90">
                        {conn?.name ?? e.connection_id.slice(0, 8)}
                      </span>
                      <span className="ml-auto tabular-nums">
                        {e.elapsed_ms}ms
                      </span>
                    </div>
                    <pre className="max-h-12 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11.5px] leading-[1.35] text-foreground/85 line-clamp-2">
                      {e.sql.trim()}
                    </pre>
                    <div className="flex items-center justify-between text-[10.5px] text-muted-foreground">
                      <span>
                        {e.row_count != null
                          ? `${e.row_count} rows`
                          : e.rows_affected != null
                          ? `${e.rows_affected} affected`
                          : ""}
                      </span>
                      <span>{timeAgo(e.at)}</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t("sidebar.clear")}
        message={t("confirm.clear_history")}
        confirmLabel={t("sidebar.clear")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => void doClear()}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function timeAgo(rfc3339: string) {
  const now = Date.now();
  const t = Date.parse(rfc3339);
  if (isNaN(t)) return rfc3339;
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
