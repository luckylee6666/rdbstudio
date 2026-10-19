import type { WorkspaceTab } from "@/types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

// Tab titles are persisted, so default labels are stored as stable English
// tokens and localized here at render time; user-visible names (tables, keys,
// connections) pass through untouched.
const QUERY_TITLE = /^(?:Query|New query|新建查询)(?: (\d+))?$/;
const SUBTITLE_KEYS: Record<string, string> = {
  Data: "tabs.sub.data",
  View: "tabs.sub.view",
  Design: "tabs.sub.design",
  Diagram: "tabs.sub.diagram",
};
const TOOL_TITLE_KEYS: Partial<Record<WorkspaceTab["kind"], string>> = {
  sync: "tool.sync.title",
  search: "tool.search.title",
  objects: "tool.objects.title",
  "redis-tools": "tool.redis.title",
};

export function tabDisplay(tab: WorkspaceTab, t: Translate): { title: string; subtitle?: string } {
  if (tab.kind === "welcome") return { title: t("tabs.welcome") };
  const toolKey = TOOL_TITLE_KEYS[tab.kind];
  if (toolKey) return { title: t(toolKey) };
  let title = tab.title;
  if (tab.kind === "query") {
    const m = QUERY_TITLE.exec(title);
    if (m) title = m[1] ? `${t("tabs.query")} ${m[1]}` : t("tabs.query");
  }
  const sub = tab.subtitle;
  const subtitle =
    !sub || sub === "Untitled" ? undefined : SUBTITLE_KEYS[sub] ? t(SUBTITLE_KEYS[sub]) : sub;
  return { title, subtitle };
}
