import { ConnectionTree } from "@/components/connection/ConnectionTree";
import { HistoryPanel } from "@/components/layout/HistoryPanel";
import { useLayout } from "@/store/layout";
import { FavoritesPanel } from "@/components/layout/FavoritesPanel";
import { QueriesPanel } from "@/components/layout/QueriesPanel";
import { ModelsPanel } from "@/components/layout/ModelsPanel";

export function Sidebar() {
  const activity = useLayout((s) => s.activity);
  return (
    <aside className="w-[280px] shrink-0 border-r border-border/70 bg-surface-muted/40">
      {activity === "connections" && <ConnectionTree />}
      {activity === "queries" && <QueriesPanel />}
      {activity === "history" && <HistoryPanel />}
      {activity === "favorites" && <FavoritesPanel />}
      {activity === "models" && <ModelsPanel />}
    </aside>
  );
}
