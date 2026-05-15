import { Plus, Table2, Terminal, X, Sparkles, Workflow, Settings2, Key } from "lucide-react";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/store/workspace";
import type { TabKind } from "@/types";
import { Welcome } from "./Welcome";
import { TableDataView } from "./TableDataView";
import { QueryEditorView } from "./QueryEditorView";
import { DesignerView } from "./DesignerView";
import { ERView } from "./ERView";
import { RedisKeyView } from "./RedisKeyView";

function tabIcon(kind: TabKind) {
  switch (kind) {
    case "query":
      return Terminal;
    case "table-data":
      return Table2;
    case "designer":
      return Settings2;
    case "er":
      return Workflow;
    case "welcome":
      return Sparkles;
    case "redis-key":
      return Key;
    default:
      return Terminal;
  }
}

export function WorkspaceTabs() {
  const { tabs, activeTabId, setActive, closeTab, openTab } = useWorkspace();
  const active = tabs.find((t) => t.id === activeTabId) ?? null;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center border-b border-border/70 bg-surface/40">
        <div className="flex min-w-0 flex-1 items-end overflow-x-auto">
          {tabs.map((t) => {
            const Icon = tabIcon(t.kind);
            const isActive = t.id === activeTabId;
            return (
              <button
                key={t.id}
                onClick={() => setActive(t.id)}
                className={cn(
                  "group relative flex h-10 min-w-0 items-center gap-2 border-r border-border/70 px-3 text-[13px]",
                  isActive
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {isActive && (
                  <span className="absolute inset-x-0 top-0 h-[2px] bg-brand" />
                )}
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate max-w-[160px]">{t.title}</span>
                {t.subtitle && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {t.subtitle}
                  </span>
                )}
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  className={cn(
                    "ml-1 grid h-4 w-4 place-items-center rounded opacity-0 hover:bg-accent group-hover:opacity-100",
                    isActive && "opacity-60"
                  )}
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            );
          })}
        </div>
        <button
          onClick={() =>
            openTab({
              id: `query:${crypto.randomUUID()}`,
              kind: "query",
              title: "Query",
              subtitle: "Untitled",
            })
          }
          className="mx-2 grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title="New query"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1">
        {!active && <Welcome />}
        {active?.kind === "welcome" && <Welcome />}
        {active?.kind === "table-data" && <TableDataView tab={active} />}
        {active?.kind === "query" && <QueryEditorView tab={active} />}
        {active?.kind === "designer" && <DesignerView tab={active} />}
        {active?.kind === "er" && <ERView tab={active} />}
        {active?.kind === "redis-key" && <RedisKeyView tab={active} />}
      </div>
    </section>
  );
}
