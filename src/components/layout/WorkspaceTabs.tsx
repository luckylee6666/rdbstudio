import { useEffect, useRef, useState } from "react";
import {
  Plus,
  Table2,
  Terminal,
  X,
  XCircle,
  Sparkles,
  Workflow,
  Settings2,
  Key,
  Network,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/store/workspace";
import { useT } from "@/store/i18n";
import { ContextMenu } from "@/components/ui/ContextMenu";
import type { TabKind } from "@/types";
import { Welcome } from "./Welcome";
import { TableDataView } from "./TableDataView";
import { QueryEditorView } from "./QueryEditorView";
import { DesignerView } from "./DesignerView";
import { ERView } from "./ERView";
import { ExplainView } from "./ExplainView";
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
    case "explain":
      return Network;
    case "welcome":
      return Sparkles;
    case "redis-key":
      return Key;
    default:
      return Terminal;
  }
}

export function WorkspaceTabs() {
  const {
    tabs,
    activeTabId,
    setActive,
    closeTab,
    closeOthers,
    closeToRight,
    closeAll,
    openTab,
  } = useWorkspace();
  const active = tabs.find((t) => t.id === activeTabId) ?? null;
  const stripRef = useRef<HTMLDivElement>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(
    null
  );
  const t = useT();

  // Tabs opened off-screen (FK jump, palette) must scroll into view, or the
  // strip silently activates something the user can't see.
  useEffect(() => {
    if (!activeTabId) return;
    stripRef.current
      ?.querySelector(`[data-tab-id="${CSS.escape(activeTabId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center border-b border-border/70 bg-surface/40">
        <div ref={stripRef} className="flex min-w-0 flex-1 items-end overflow-x-auto">
          {tabs.map((tab) => {
            const Icon = tabIcon(tab.kind);
            const isActive = tab.id === activeTabId;
            return (
              <button
                key={tab.id}
                data-tab-id={tab.id}
                onClick={() => setActive(tab.id)}
                onAuxClick={(e) => {
                  // Middle-click closes, matching every browser/IDE tab strip.
                  if (e.button === 1) {
                    e.preventDefault();
                    closeTab(tab.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setCtx({ x: e.clientX, y: e.clientY, id: tab.id });
                }}
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
                <span className="truncate max-w-[160px]">{tab.title}</span>
                {tab.subtitle && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {tab.subtitle}
                  </span>
                )}
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
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
          title={t("tabs.new_query")}
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
        {active?.kind === "explain" && <ExplainView tab={active} />}
        {active?.kind === "redis-key" && <RedisKeyView tab={active} />}
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={[
            {
              id: "close",
              label: t("tabs.close"),
              icon: X,
              onClick: () => closeTab(ctx.id),
            },
            {
              id: "close-others",
              label: t("tabs.close_others"),
              disabled: tabs.length < 2,
              onClick: () => closeOthers(ctx.id),
            },
            {
              id: "close-right",
              label: t("tabs.close_right"),
              disabled: tabs.findIndex((x) => x.id === ctx.id) >= tabs.length - 1,
              onClick: () => closeToRight(ctx.id),
            },
            { id: "sep", label: "", separator: true },
            {
              id: "close-all",
              label: t("tabs.close_all"),
              icon: XCircle,
              danger: true,
              onClick: () => closeAll(),
            },
          ]}
          onClose={() => setCtx(null)}
        />
      )}
    </section>
  );
}
