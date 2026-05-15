import { create } from "zustand";
import { translations, type Lang } from "@/i18n/translations";

const STORAGE_KEY = "rdbstudio.lang";

function detectDefault(): Lang {
  if (typeof window === "undefined") return "zh";
  const stored = localStorage.getItem(STORAGE_KEY) as Lang | null;
  if (stored === "zh" || stored === "en") return stored;
  const nav = navigator.language || "";
  return nav.toLowerCase().startsWith("zh") ? "zh" : "en";
}

interface I18nState {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggle: () => void;
}

export const useI18n = create<I18nState>((set, get) => ({
  lang: detectDefault(),
  setLang: (l) => {
    localStorage.setItem(STORAGE_KEY, l);
    set({ lang: l });
  },
  toggle: () => {
    const next: Lang = get().lang === "zh" ? "en" : "zh";
    localStorage.setItem(STORAGE_KEY, next);
    set({ lang: next });
  },
}));

export function useT() {
  const lang = useI18n((s) => s.lang);
  return (key: string, params?: Record<string, string | number>) =>
    translate(lang, key, params);
}

export function translate(
  lang: Lang,
  key: string,
  params?: Record<string, string | number>
): string {
  const dict = translations[lang] ?? translations.en;
  let s = dict[key] ?? translations.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), String(v));
    }
  }
  return s;
}
