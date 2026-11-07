import { GitBranch, Lock, Plug, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { connColorValue } from "@/lib/connColors";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import { tabDisplay } from "@/lib/tabTitles";

export function StatusBar() {
  const activeTab = useWorkspace((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId)
  );
  const connections = useConnections((s) => s.list);
  const statusMap = useConnections((s) => s.status);
  const versions = useConnections((s) => s.versions);
  const t = useT();

  // Prefer the active tab's connection; else the single connected one.
  const connectedIds = connections.filter(
    (c) => statusMap[c.id] === "connected"
  );
  const cfg =
    connections.find((c) => c.id === activeTab?.connectionId) ??
    (connectedIds.length === 1 ? connectedIds[0] : undefined);
  const status = cfg ? statusMap[cfg.id] : undefined;
  const version = cfg ? versions[cfg.id] : undefined;
  const color = connColorValue(cfg?.color);

  return (
    <footer className="flex h-6 shrink-0 items-center overflow-hidden whitespace-nowrap gap-3 border-t border-border/70 bg-surface/60 px-3 text-[11px] text-muted-foreground">
      {cfg ? (
        <>
          <span className="flex min-w-0 max-w-[24%] shrink-0 items-center gap-1" title={cfg.name}>
            {color && (
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: color }}
              />
            )}
            <Plug className="h-3 w-3 shrink-0" />
            <span className="truncate">{cfg.name}</span>
          </span>
          {cfg.read_only && (
            <span className="flex shrink-0 items-center gap-1 text-warning">
              <Lock className="h-3 w-3" />
              {t("conn.badge.read_only")}
            </span>
          )}
          {activeTab?.schema && (
            <span className="flex min-w-0 max-w-[16%] items-center gap-1" title={activeTab.schema}>
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{activeTab.schema}</span>
            </span>
          )}
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {status === "connected" ? (
              <Wifi className="h-3 w-3 shrink-0 text-success" />
            ) : (
              <WifiOff
                className={cn(
                  "h-3 w-3 shrink-0",
                  status === "error" ? "text-danger" : "text-muted-foreground"
                )}
              />
            )}
            <span className="shrink-0">{status === "connected"
              ? t("status.connected")
              : status === "connecting"
              ? t("status.connecting")
              : status === "error"
              ? t("status.error")
              : t("status.disconnected")}</span>
            {status === "connected" && version && <span className="truncate" title={version}>· {version}</span>}
          </span>
        </>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <WifiOff className="h-3 w-3" />
          {t("status.no_connection")}
        </span>
      )}
      {cfg && <span className="shrink-0 uppercase">{cfg.driver}</span>}
      {activeTab && (
        <>
          <span>·</span>
          <span className="max-w-[16%] shrink-0 truncate">{tabDisplay(activeTab, t).title}</span>
        </>
      )}
    </footer>
  );
}
