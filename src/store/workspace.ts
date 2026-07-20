import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WorkspaceTab } from "@/types";

// Editor buffers live outside the store (rdb:buf:<tabId> in localStorage,
// rdb:sql:<tabId> primes in sessionStorage) — scrub them when tabs close so
// storage doesn't accumulate orphans.
function cleanupTabStorage(ids: string[]) {
  try {
    for (const id of ids) {
      localStorage.removeItem(`rdb:buf:${id}`);
      sessionStorage.removeItem(`rdb:sql:${id}`);
    }
  } catch {
    /* storage unavailable — nothing to clean */
  }
}

interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  openTab: (tab: WorkspaceTab) => void;
  closeTab: (id: string) => void;
  closeOthers: (id: string) => void;
  closeToRight: (id: string) => void;
  closeAll: () => void;
  setActive: (id: string) => void;
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      tabs: [
        {
          id: "welcome",
          kind: "welcome",
          title: "Welcome",
        },
      ],
      activeTabId: "welcome",
      openTab: (tab) => {
        const existing = get().tabs.find((t) => t.id === tab.id);
        if (existing) {
          set({ activeTabId: tab.id });
          return;
        }
        set({ tabs: [...get().tabs, tab], activeTabId: tab.id });
      },
      closeTab: (id) => {
        cleanupTabStorage([id]);
        const tabs = get().tabs.filter((t) => t.id !== id);
        const activeTabId =
          get().activeTabId === id
            ? tabs[tabs.length - 1]?.id ?? null
            : get().activeTabId;
        set({ tabs, activeTabId });
      },
      closeOthers: (id) => {
        const kept = get().tabs.filter((t) => t.id === id);
        if (kept.length === 0) return;
        cleanupTabStorage(
          get()
            .tabs.filter((t) => t.id !== id)
            .map((t) => t.id)
        );
        set({ tabs: kept, activeTabId: id });
      },
      closeToRight: (id) => {
        const tabs = get().tabs;
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx < 0) return;
        cleanupTabStorage(tabs.slice(idx + 1).map((t) => t.id));
        const kept = tabs.slice(0, idx + 1);
        const active = get().activeTabId;
        set({
          tabs: kept,
          activeTabId: kept.some((t) => t.id === active) ? active : id,
        });
      },
      closeAll: () => {
        cleanupTabStorage(get().tabs.map((t) => t.id));
        set({ tabs: [], activeTabId: null });
      },
      setActive: (id) => set({ activeTabId: id }),
    }),
    {
      // Restores the open workspace across restarts. Editor buffers are
      // restored separately by QueryEditorView from rdb:buf:<tabId>.
      name: "rdb:workspace",
      partialize: (s) => ({ tabs: s.tabs, activeTabId: s.activeTabId }),
    }
  )
);
