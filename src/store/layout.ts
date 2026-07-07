import { create } from "zustand";

export type ActivityId = "connections" | "queries" | "history" | "favorites" | "models" | "snippets";

interface LayoutState {
  activity: ActivityId;
  paletteOpen: boolean;
  sidebarVisible: boolean;
  setActivity: (a: ActivityId) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  toggleSidebar: () => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  activity: "connections",
  paletteOpen: false,
  sidebarVisible: true,
  setActivity: (a) => set({ activity: a }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
  toggleSidebar: () => set({ sidebarVisible: !get().sidebarVisible }),
}));
