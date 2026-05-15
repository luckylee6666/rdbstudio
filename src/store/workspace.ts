import { create } from "zustand";
import type { WorkspaceTab } from "@/types";

interface WorkspaceState {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  openTab: (tab: WorkspaceTab) => void;
  closeTab: (id: string) => void;
  setActive: (id: string) => void;
}

export const useWorkspace = create<WorkspaceState>((set, get) => ({
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
    const tabs = get().tabs.filter((t) => t.id !== id);
    const activeTabId =
      get().activeTabId === id ? tabs[tabs.length - 1]?.id ?? null : get().activeTabId;
    set({ tabs, activeTabId });
  },
  setActive: (id) => set({ activeTabId: id }),
}));
