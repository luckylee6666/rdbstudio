import { create } from "zustand";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  // Optional secondary line — used for error stacks etc. Kept separate so the
  // primary title stays short and scannable.
  detail?: string;
}

interface ToastsState {
  items: Toast[];
  push: (t: Omit<Toast, "id"> & { durationMs?: number }) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let _nextId = 1;
const DEFAULT_DURATION: Record<ToastKind, number> = {
  info: 3500,
  success: 2500,
  error: 6000, // Errors stay longer; users may want to read the detail.
};

export const useToasts = create<ToastsState>((set, get) => ({
  items: [],
  push: ({ kind, title, detail, durationMs }) => {
    const id = _nextId++;
    set((s) => ({ items: [...s.items, { id, kind, title, detail }] }));
    const ms = durationMs ?? DEFAULT_DURATION[kind];
    if (ms > 0) {
      setTimeout(() => get().dismiss(id), ms);
    }
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
  clear: () => set({ items: [] }),
}));

// Imperative helpers — let .catch(toastError(...)) work without hooks.
export const toast = {
  info: (title: string, detail?: string) =>
    useToasts.getState().push({ kind: "info", title, detail }),
  success: (title: string, detail?: string) =>
    useToasts.getState().push({ kind: "success", title, detail }),
  error: (title: string, detail?: string) =>
    useToasts.getState().push({ kind: "error", title, detail }),
};
