import { create } from "zustand";

export type ActivityId = "connections" | "queries" | "history" | "favorites" | "models";

interface LayoutState {
  activity: ActivityId;
  paletteOpen: boolean;
  setActivity: (a: ActivityId) => void;
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
}

export const useLayout = create<LayoutState>((set, get) => ({
  activity: "connections",
  paletteOpen: false,
  setActivity: (a) => set({ activity: a }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
}));
