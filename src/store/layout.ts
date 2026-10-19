import { create } from "zustand";

export type ActivityId = "connections" | "queries" | "history" | "favorites" | "models" | "snippets";

const INSPECTOR_KEY = "rdb:inspectorVisible";

function loadInspectorVisible(): boolean {
  try {
    return localStorage.getItem(INSPECTOR_KEY) !== "0";
  } catch {
    return true;
  }
}

interface LayoutState {
  activity: ActivityId;
  paletteOpen: boolean;
  sidebarVisible: boolean;
  inspectorVisible: boolean;
  setActivity: (a: ActivityId) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  toggleSidebar: () => void;
  toggleInspector: () => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  activity: "connections",
  paletteOpen: false,
  sidebarVisible: true,
  inspectorVisible: loadInspectorVisible(),
  setActivity: (a) => set({ activity: a }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
  toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),
  toggleInspector: () => {
    const next = !get().inspectorVisible;
    try {
      localStorage.setItem(INSPECTOR_KEY, next ? "1" : "0");
    } catch {
      // Preference only; the toggle still works for this session.
    }
    set({ inspectorVisible: next });
  },
}));
