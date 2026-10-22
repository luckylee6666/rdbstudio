import { useState } from "react";
import {
  Activity,
  Database,
  History,
  Settings,
  Star,
  Terminal,
  Workflow,
  FileCode,
  ArrowRightLeft,
  Search,
  Users,
  Radio,
} from "lucide-react";
import { useWorkspace } from "@/store/workspace";
import { cn } from "@/lib/cn";
import { useLayout, type ActivityId } from "@/store/layout";
import { useT } from "@/store/i18n";
import { SettingsDialog } from "./SettingsDialog";

const items: { id: ActivityId; icon: typeof Database; labelKey: string }[] = [
  { id: "connections", icon: Database, labelKey: "activity.connections" },
  { id: "queries", icon: Terminal, labelKey: "activity.queries" },
  { id: "history", icon: History, labelKey: "activity.history" },
  { id: "favorites", icon: Star, labelKey: "activity.favorites" },
  { id: "models", icon: Workflow, labelKey: "activity.models" },
  { id: "snippets", icon: FileCode, labelKey: "activity.snippets" },
];

const tools = [
  { kind: "sync", icon: ArrowRightLeft, labelKey: "tool.sync.title" },
  { kind: "search", icon: Search, labelKey: "tool.search.title" },
  { kind: "objects", icon: Users, labelKey: "tool.objects.title" },
  { kind: "redis-tools", icon: Radio, labelKey: "tool.redis.title" },
  { kind: "monitor", icon: Activity, labelKey: "tool.monitor.title" },
] as const;

export function ActivityBar() {
  const { activity, setActivity } = useLayout();
  const t = useT();
  const openTab = useWorkspace((s) => s.openTab);
  const activeKind = useWorkspace(
    (s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.kind
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border/70 bg-surface/40 py-2">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => setActivity(it.id)}
          title={t(it.labelKey)}
          className={cn(
            "relative grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors",
            "hover:bg-accent hover:text-foreground",
            activity === it.id && "bg-accent text-foreground"
          )}
        >
          {activity === it.id && (
            <span className="absolute left-0 h-5 w-0.5 rounded-r-full bg-brand" />
          )}
          <it.icon className="h-[18px] w-[18px]" />
        </button>
      ))}
      <div className="my-2 h-px w-6 bg-border" />
      {tools.map((item) => {
        const active = activeKind === item.kind;
        return (
          <button
            key={item.kind}
            title={t(item.labelKey)}
            aria-label={t(item.labelKey)}
            onClick={() =>
              openTab({ id: `tool:${item.kind}`, kind: item.kind, title: t(item.labelKey) })
            }
            className={cn(
              "relative grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors",
              "hover:bg-accent hover:text-foreground",
              active && "bg-accent text-foreground"
            )}
          >
            {active && <span className="absolute left-0 h-5 w-0.5 rounded-r-full bg-brand" />}
            <item.icon className="h-[18px] w-[18px]" />
          </button>
        );
      })}
      <div className="flex-1" />
      <button
        onClick={() => setSettingsOpen(true)}
        title={t("activity.settings")}
        className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Settings className="h-[18px] w-[18px]" />
      </button>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </nav>
  );
}
