import { useEffect } from "react";
import { Workflow, Plus, Database, Loader2 } from "lucide-react";
import { useWorkspace } from "@/store/workspace";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { cn } from "@/lib/cn";
import { DriverBadge } from "@/components/connection/driverIcon";

export function ModelsPanel() {
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const openTab = useWorkspace((s) => s.openTab);
  const setActive = useWorkspace((s) => s.setActive);
  const connections = useConnections((s) => s.list);
  const status = useConnections((s) => s.status);
  const branches = useConnections((s) => s.branches);
  const loadDatabases = useConnections((s) => s.loadDatabases);
  const t = useT();

  const erTabs = tabs.filter((x) => x.kind === "er");
  const connected = connections.filter(
    (c) => (status[c.id] ?? "disconnected") === "connected"
  );

  useEffect(() => {
    for (const c of connected) {
      if (!branches[c.id]?.databases) void loadDatabases(c.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected.length]);

  const openEr = (connId: string, schema: string | undefined, label: string) => {
    const id = `er:${connId}:${schema ?? ""}`;
    openTab({
      id,
      kind: "er",
      title: `${label} · ER`,
      subtitle: "Diagram",
      connectionId: connId,
      schema,
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-3 pb-2 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("models.panel.title")}
      </div>

      <div className="flex-1 overflow-auto px-2 pb-3">
        {erTabs.length > 0 && (
          <div className="mb-3">
            <div className="px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("models.panel.open")}
            </div>
            {erTabs.map((tb) => {
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
                  <Workflow
                    className={cn(
                      "h-3.5 w-3.5 shrink-0",
                      active ? "text-brand" : "text-violet-400"
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
        )}

        {connected.length === 0 ? (
          <Empty />
        ) : (
          <div>
            <div className="px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("models.panel.create")}
            </div>
            {connected.map((c) => {
              const dbs = branches[c.id]?.databases;
              return (
                <div key={c.id} className="mb-2">
                  <div className="flex items-center gap-1.5 px-1.5 py-0.5 text-[12px] font-medium text-foreground/80">
                    <DriverBadge driver={c.driver} />
                    <span className="truncate">{c.name}</span>
                  </div>
                  <div className="ml-5 border-l border-border/60 pl-1">
                    {!dbs ? (
                      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        loading…
                      </div>
                    ) : dbs.length === 0 ? (
                      <div className="px-2 py-1 text-[11px] text-muted-foreground">
                        (no databases)
                      </div>
                    ) : (
                      dbs.map((db) => (
                        <button
                          key={db}
                          onClick={() =>
                            openEr(c.id, db === "main" ? undefined : db, db)
                          }
                          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12.5px] text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                        >
                          <Plus className="h-3 w-3" />
                          <Database className="h-3.5 w-3.5 text-brand/80" />
                          <span className="truncate">{db}</span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Empty() {
  const t = useT();
  return (
    <div className="mt-6 rounded-lg border border-dashed border-border/80 bg-surface-muted/30 p-5 text-center">
      <div className="mb-2 inline-grid h-9 w-9 place-items-center rounded-md bg-accent">
        <Workflow className="h-4 w-4" />
      </div>
      <div className="text-[13px] font-medium">{t("models.panel.empty.title")}</div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground">
        {t("models.panel.empty.desc")}
      </div>
    </div>
  );
}
