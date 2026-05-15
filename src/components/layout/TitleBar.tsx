import { Database, Globe, Moon, Search, Sun } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTheme } from "@/components/theme/ThemeProvider";
import { cn } from "@/lib/cn";
import { useLayout } from "@/store/layout";
import { useI18n, useT } from "@/store/i18n";

const INTERACTIVE = "button, input, select, textarea, a, kbd, [data-no-drag]";

async function handleDragMouseDown(e: React.MouseEvent) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest(INTERACTIVE)) return;
  try {
    await getCurrentWindow().startDragging();
  } catch {
    /* non-tauri runtime (vite preview) */
  }
}

async function handleDoubleClick(e: React.MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.closest(INTERACTIVE)) return;
  try {
    const w = getCurrentWindow();
    const maximized = await w.isMaximized();
    if (maximized) await w.unmaximize();
    else await w.maximize();
  } catch {
    /* ignore */
  }
}

export function TitleBar() {
  const { theme, toggle } = useTheme();
  const openPalette = useLayout((s) => s.openPalette);
  const t = useT();
  const { lang, toggle: toggleLang } = useI18n();
  return (
    <header
      data-tauri-drag-region
      onMouseDown={handleDragMouseDown}
      onDoubleClick={handleDoubleClick}
      className={cn(
        "h-11 shrink-0 border-b border-border/70",
        "flex items-center gap-3 px-3 text-sm",
        "bg-surface/60 backdrop-blur"
      )}
    >
      <div
        data-tauri-drag-region
        className="flex items-center gap-2 pl-[68px]"
      >
        <div className="pointer-events-none grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-brand to-brand/60 text-brand-foreground shadow-soft">
          <Database className="h-3.5 w-3.5" />
        </div>
        <span className="pointer-events-none font-medium tracking-tight">
          rdbstudio
        </span>
      </div>

      <button
        onClick={openPalette}
        className="mx-auto flex w-[420px] max-w-[48%] items-center gap-2 rounded-lg border border-border/70 bg-surface-muted/80 px-3 py-1.5 text-xs text-muted-foreground shadow-soft hover:bg-surface-muted"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="flex-1 truncate text-left">{t("titlebar.search")}</span>
        <kbd className="rounded bg-surface px-1.5 py-0.5 text-[10px] font-medium">
          ⌘K
        </kbd>
      </button>

      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={toggleLang}
          title={t("activity.lang.toggle")}
          className="flex h-7 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Globe className="h-3.5 w-3.5" />
          <span className="uppercase">{lang}</span>
        </button>
        <button
          onClick={toggle}
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={
            theme === "dark"
              ? t("activity.theme.light")
              : t("activity.theme.dark")
          }
        >
          {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
      </div>
    </header>
  );
}
