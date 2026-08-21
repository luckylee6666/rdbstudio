import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectionTree } from "@/components/connection/ConnectionTree";
import { HistoryPanel } from "@/components/layout/HistoryPanel";
import { useLayout } from "@/store/layout";
import { FavoritesPanel } from "@/components/layout/FavoritesPanel";
import { QueriesPanel } from "@/components/layout/QueriesPanel";
import { ModelsPanel } from "@/components/layout/ModelsPanel";
import { SnippetsPanel } from "@/components/layout/SnippetsPanel";
import { useT } from "@/store/i18n";

const SIDEBAR_WIDTH_KEY = "rdb:sidebarWidth";
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 560;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

function loadSidebarWidth(): number {
  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return saved > 0 ? clampSidebarWidth(saved) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

function saveSidebarWidth(width: number) {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    // A denied/disabled localStorage must not break layout resizing.
  }
}

export function Sidebar() {
  const activity = useLayout((s) => s.activity);
  const t = useT();
  const [width, setWidth] = useState(loadSidebarWidth);
  const widthRef = useRef(width);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const asideRef = useRef<HTMLElement | null>(null);
  const separatorRef = useRef<HTMLDivElement | null>(null);

  // Live pointer movement updates only the two affected DOM properties. Keeping
  // it out of React state prevents the active panel (and a large connection
  // tree) from being reconciled on every pointer event.
  const previewWidth = useCallback((next: number) => {
    const clamped = clampSidebarWidth(next);
    widthRef.current = clamped;
    if (asideRef.current) asideRef.current.style.width = `${clamped}px`;
    separatorRef.current?.setAttribute("aria-valuenow", String(clamped));
    return clamped;
  }, []);

  const commitWidth = useCallback((next: number) => {
    const clamped = previewWidth(next);
    setWidth(clamped);
    saveSidebarWidth(clamped);
  }, [previewWidth]);

  const finishResize = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setWidth(widthRef.current);
    saveSidebarWidth(widthRef.current);
  }, []);

  useEffect(() => {
    window.addEventListener("blur", finishResize);
    return () => {
      window.removeEventListener("blur", finishResize);
      if (dragRef.current) saveSidebarWidth(widthRef.current);
      dragRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [finishResize]);

  return (
    <aside
      ref={asideRef}
      className="relative shrink-0 border-r border-border/70 bg-surface-muted/40"
      style={{ width }}
    >
      {activity === "connections" && <ConnectionTree />}
      {activity === "queries" && <QueriesPanel />}
      {activity === "history" && <HistoryPanel />}
      {activity === "favorites" && <FavoritesPanel />}
      {activity === "models" && <ModelsPanel />}
      {activity === "snippets" && <SnippetsPanel />}

      <div
        ref={separatorRef}
        role="separator"
        aria-label={t("sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        title={t("sidebar.resize.hint")}
        className="group absolute -right-1 top-0 z-30 h-full w-2 touch-none cursor-col-resize outline-none"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragRef.current = { startX: event.clientX, startWidth: widthRef.current };
          event.currentTarget.setPointerCapture?.(event.pointerId);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          previewWidth(drag.startWidth + event.clientX - drag.startX);
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onLostPointerCapture={finishResize}
        onDoubleClick={() => commitWidth(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={(event) => {
          let next = widthRef.current;
          if (event.key === "ArrowLeft") next -= 16;
          else if (event.key === "ArrowRight") next += 16;
          else if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
          else if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
          else return;
          event.preventDefault();
          commitWidth(next);
        }}
      >
        <div className="absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-brand/60 group-focus:bg-brand/70" />
      </div>
    </aside>
  );
}
