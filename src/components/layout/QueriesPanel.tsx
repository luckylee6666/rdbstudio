import { useMemo } from "react";
import { Plus, Terminal, Database } from "lucide-react";
import { useWorkspace } from "@/store/workspace";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { cn } from "@/lib/cn";
import { DriverBadge } from "@/components/connection/driverIcon";

export function QueriesPanel() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const openTab = useWorkspace((s) => s.openTab);
  const setActive = useWorkspace((s) => s.setActive);
  const connections = useConnections((s) => s.list);
  const status = useConnections((s) => s.status);
  const t = useT();

  const queryTabs = useMemo(
    () => tabs.filter((x) => x.kind === "query"),
    [tabs]
  );

  const grouped = useMemo(() => {
    const map = new Map<string, typeof queryTabs>();
    for (const tb of queryTabs) {
      const key = tb.connectionId ?? "__unbound__";
      const arr = map.get(key) ?? [];
      arr.push(tb);
      map.set(key, arr);
    }
    return Array.from(map.entries());
  }, [queryTabs]);

  const newQuery = (connectionId?: string) =>
    openTab({
      id: `query:${crypto.randomUUID()}`,
      kind: "query",
      title: t("welcome.action.new_query"),
      subtitle: connectionId
        ? connections.find((c) => c.id === connectionId)?.name
        : "Untitled",
      connectionId,
    });

  const connected = connections.filter(
    (c) => (status[c.id] ?? "disconnected") === "connected"
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("queries.panel.title")}
        </div>
        <button
          onClick={() => newQuery()}
          title={t("welcome.action.new_query")}
          className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-2 pb-3">
        {queryTabs.length === 0 ? (
          <Empty onNew={() => newQuery()} />
        ) : (
          grouped.map(([connId, tabsInGroup]) => {
            const conn =
              connId === "__unbound__"
                ? null
                : connections.find((c) => c.id === connId) ?? null;
            return (
              <div key={connId} className="mb-3">
                <div className="flex items-center gap-1.5 px-1.5 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
                  {conn ? (
                    <>
                      <DriverBadge driver={conn.driver} />
                      <span className="truncate font-medium text-foreground/80">
                        {conn.name}
                      </span>
                    </>
                  ) : (
                    <>
                      <Database className="h-3.5 w-3.5" />
                      {t("queries.panel.unbound")}
                    </>
                  )}
                  <span className="ml-auto rounded bg-surface-muted px-1.5 text-[10.5px] tabular-nums text-muted-foreground">
                    {tabsInGroup.length}
                  </span>
                </div>
                {tabsInGroup.map((tb) => {
                  const active = tb.id === activeTabId;
                  return (
                    <button
                      key={tb.id}
                      onClick={() => setActive(tb.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent/50",
                        active && "bg-accent text-foreground"
                      )}
                    >
                      <Terminal
                        className={cn(
                          "h-3.5 w-3.5 shrink-0",
                          active ? "text-brand" : "text-muted-foreground"
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{tb.title}</div>
                        {tb.subtitle && (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {tb.subtitle}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            );
          })
        )}

        {connected.length > 0 && (
          <div className="mt-2 border-t border-border/60 pt-2">
            <div className="mb-1 px-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("queries.panel.new_on")}
            </div>
            {connected.map((c) => (
              <button
                key={c.id}
                onClick={() => newQuery(c.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
              >
                <Plus className="h-3 w-3" />
                <DriverBadge driver={c.driver} />
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty({ onNew }: { onNew: () => void }) {
  const t = useT();
  return (
    <div className="mt-6 rounded-lg border border-dashed border-border/80 bg-surface-muted/30 p-5 text-center">
      <div className="mb-2 inline-grid h-9 w-9 place-items-center rounded-md bg-accent text-foreground">
        <Terminal className="h-4 w-4" />
      </div>
      <div className="text-[13px] font-medium">{t("queries.panel.empty.title")}</div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground">
        {t("queries.panel.empty.desc")}
      </div>
      <button
        onClick={onNew}
        className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md bg-brand px-2.5 text-[12px] font-medium text-brand-foreground hover:bg-brand/90"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("welcome.action.new_query")}
      </button>
    </div>
  );
}
