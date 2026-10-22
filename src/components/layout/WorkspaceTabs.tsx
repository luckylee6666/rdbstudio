import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowRightLeft,
  Plus,
  Radio,
  Search,
  Table2,
  Terminal,
  Users,
  X,
  XCircle,
  Sparkles,
  Workflow,
  Settings2,
  Key,
  Network,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { nextQueryTitle, useWorkspace } from "@/store/workspace";
import { useT } from "@/store/i18n";
import { ContextMenu } from "@/components/ui/ContextMenu";
import { tabDisplay } from "@/lib/tabTitles";
import type { TabKind } from "@/types";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Welcome } from "./Welcome";
import { TableDataView } from "./TableDataView";
import { QueryEditorView } from "./QueryEditorView";
import { DesignerView } from "./DesignerView";
import { ERView } from "./ERView";
import { ExplainView } from "./ExplainView";
import { ConnectionToolsView } from "./ConnectionToolsView";
import { GlobalSearchView } from "./GlobalSearchView";
import { SyncView } from "./SyncView";
import { RedisKeyView } from "./RedisKeyView";
import { ServerMonitorView } from "./ServerMonitorView";

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
    case "sync":
      return ArrowRightLeft;
    case "search":
      return Search;
    case "objects":
      return Users;
    case "redis-tools":
      return Radio;
    case "monitor":
      return Activity;
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
    pendingClose,
    confirmClose,
    cancelClose,
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
        <div
          ref={stripRef}
          onWheel={(e) => {
            // A vertical wheel over the strip pages through tabs sideways.
            if (e.deltaY !== 0 && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
              e.currentTarget.scrollLeft += e.deltaY;
            }
          }}
          className="scrollbar-none flex min-w-0 flex-1 items-end overflow-x-auto"
        >
          {tabs.map((tab) => {
            const Icon = tabIcon(tab.kind);
            const isActive = tab.id === activeTabId;
            const { title, subtitle } = tabDisplay(tab, t);
            return (
              <button
                key={tab.id}
                data-tab-id={tab.id}
                title={subtitle ? `${title} — ${subtitle}` : title}
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
                  "group relative flex h-10 min-w-[104px] max-w-[240px] shrink-0 items-center gap-2 border-r border-border/70 pl-3 pr-2 text-[12.5px] transition-colors",
                  isActive
                    ? "bg-background text-foreground"
                    : "text-muted-foreground hover:bg-surface/60 hover:text-foreground"
                )}
              >
                {isActive && (
                  <span className="absolute inset-x-0 top-0 h-[2px] bg-brand" />
                )}
                <Icon className={cn("h-3.5 w-3.5 shrink-0", isActive && "text-brand")} />
                <span className="min-w-0 truncate">{title}</span>
                {subtitle && (
                  <span className="min-w-0 max-w-[96px] shrink truncate text-[11px] text-muted-foreground/80">
                    {subtitle}
                  </span>
                )}
                {tab.transactionOpen && (
                  <span
                    title={t("query.tx.open")}
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                  />
                )}
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label={t("tabs.close")}
                  className={cn(
                    "ml-auto grid h-5 w-5 shrink-0 place-items-center rounded opacity-0 hover:bg-accent group-hover:opacity-100",
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
              title: nextQueryTitle(),
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
        {active?.kind === "welcome" && <Welcome key={active.id} />}
        {active?.kind === "table-data" && (
          <TableDataView key={active.id} tab={active} />
        )}
        {tabs.filter((tab) => tab.kind === "query").map((tab) => (
          <div key={tab.id} hidden={tab.id !== activeTabId} className="h-full">
            <QueryEditorView tab={tab} />
          </div>
        ))}
        {active?.kind === "designer" && (
          <DesignerView key={active.id} tab={active} />
        )}
        {active?.kind === "er" && <ERView key={active.id} tab={active} />}
        {active?.kind === "explain" && (
          <ExplainView key={active.id} tab={active} />
        )}
        {active?.kind === "search" && <GlobalSearchView key={active.id} />}
        {active?.kind === "sync" && <SyncView key={active.id} />}
        {(active?.kind === "objects" || active?.kind === "redis-tools") && <ConnectionToolsView key={active.id} kind={active.kind}
          initialConnectionId={active.connectionId} initialSchema={active.schema} objectKind={active.objectKind} objectName={active.objectName} />}
        {active?.kind === "redis-key" && (
          <RedisKeyView key={active.id} tab={active} />
        )}
        {active?.kind === "monitor" && (
          <ServerMonitorView
            key={active.id}
            initialConnectionId={active.connectionId}
          />
        )}
      </div>

      <ConfirmDialog
        open={pendingClose !== null}
        onClose={cancelClose}
        onConfirm={confirmClose}
        danger
        title={t("tabs.close_tx.title")}
        message={t("tabs.close_tx.message")}
        confirmLabel={t("tabs.close_tx.confirm")}
        cancelLabel={t("common.cancel")}
      />
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
