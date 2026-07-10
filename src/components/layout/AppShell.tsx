import { useEffect } from "react";
import { ActivityBar } from "./ActivityBar";
import { CommandPalette } from "./CommandPalette";
import { Inspector } from "./Inspector";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TitleBar } from "./TitleBar";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { useTheme } from "@/components/theme/ThemeProvider";
import { anyModalOpen } from "@/components/ui/Modal";
import { useLayout } from "@/store/layout";
import { useWorkspace } from "@/store/workspace";

export function AppShell() {
  const sidebarVisible = useLayout((s) => s.sidebarVisible);
  const { toggle: toggleTheme } = useTheme();

  // Global shortcuts advertised on the Welcome page / Settings: ⌘T new query,
  // ⌘W close tab, ⌘B toggle sidebar, ⌘/ theme, ⌘⇧F format SQL. ⌘K lives in
  // CommandPalette; ⌘↵ / ⌘F are CodeMirror-level bindings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // A dialog or the palette owns the keyboard: ⌘W here means "close the
      // overlay", not "close the tab hiding behind it".
      if (anyModalOpen() || useLayout.getState().paletteOpen) return;
      const k = e.key.toLowerCase();
      if (k === "t" && !e.shiftKey) {
        e.preventDefault();
        useWorkspace.getState().openTab({
          id: `query:${crypto.randomUUID()}`,
          kind: "query",
          title: "Query",
        });
      } else if (k === "w" && !e.shiftKey) {
        e.preventDefault();
        const ws = useWorkspace.getState();
        if (ws.activeTabId) ws.closeTab(ws.activeTabId);
      } else if (k === "b" && !e.shiftKey) {
        e.preventDefault();
        useLayout.getState().toggleSidebar();
      } else if (e.key === "/") {
        // CodeMirror binds Mod-/ to toggle-comment and lets the event bubble;
        // inside any editable surface this must stay a comment toggle, not a
        // theme flip.
        const el = document.activeElement as HTMLElement | null;
        if (el?.closest(".cm-editor, input, textarea, [contenteditable]")) {
          return;
        }
        e.preventDefault();
        toggleTheme();
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new Event("format-sql"));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleTheme]);

  return (
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      <TitleBar />
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        {sidebarVisible && <Sidebar />}
        <WorkspaceTabs />
        <Inspector />
      </div>
      <StatusBar />
      <CommandPalette />
    </div>
  );
}
