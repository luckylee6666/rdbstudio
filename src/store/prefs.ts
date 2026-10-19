import { create } from "zustand";
import { persist } from "zustand/middleware";

export const EDITOR_FONT_SIZES = [12, 13, 14, 15, 16, 18] as const;
export const GRID_PAGE_SIZES = [50, 100, 200, 500, 1000] as const;

interface PrefsState {
  editorFontSize: number;
  gridPageSize: number;
  setEditorFontSize: (size: number) => void;
  setGridPageSize: (size: number) => void;
}

/** User preferences that only affect presentation (kept in localStorage). */
export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      editorFontSize: 13,
      gridPageSize: 100,
      setEditorFontSize: (editorFontSize) => set({ editorFontSize }),
      setGridPageSize: (gridPageSize) => set({ gridPageSize }),
    }),
    { name: "rdb:prefs" }
  )
);
