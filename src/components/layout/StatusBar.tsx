import { GitBranch, Lock, Plug, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/cn";
import { connColorValue } from "@/lib/connColors";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";

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
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border/70 bg-surface/60 px-3 text-[11px] text-muted-foreground">
      {cfg ? (
        <>
          <span className="flex items-center gap-1">
            {color && (
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: color }}
              />
            )}
            <Plug className="h-3 w-3" />
            {cfg.name}
          </span>
          {cfg.read_only && (
            <span className="flex items-center gap-1 text-warning">
              <Lock className="h-3 w-3" />
              {t("conn.badge.read_only")}
            </span>
          )}
          {activeTab?.schema && (
            <span className="flex items-center gap-1">
              <GitBranch className="h-3 w-3" />
              {activeTab.schema}
            </span>
          )}
          <span className="flex items-center gap-1">
            {status === "connected" ? (
              <Wifi className="h-3 w-3 text-success" />
            ) : (
              <WifiOff
                className={cn(
                  "h-3 w-3",
                  status === "error" ? "text-danger" : "text-muted-foreground"
                )}
              />
            )}
            {status === "connected"
              ? t("status.connected")
              : status === "connecting"
              ? t("status.connecting")
              : status === "error"
              ? t("status.error")
              : t("status.disconnected")}
            {status === "connected" && version ? ` · ${version}` : ""}
          </span>
        </>
      ) : (
        <span className="flex items-center gap-1">
          <WifiOff className="h-3 w-3" />
          {t("status.no_connection")}
        </span>
      )}
      <div className="flex-1" />
      {cfg && <span className="uppercase">{cfg.driver}</span>}
      {activeTab && (
        <>
          <span>·</span>
          <span className="max-w-[240px] truncate">{activeTab.title}</span>
        </>
      )}
    </footer>
  );
}
