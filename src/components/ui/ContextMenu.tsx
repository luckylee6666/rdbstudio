import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export interface MenuEntry {
  id: string;
  label: string;
  icon?: React.ElementType;
  shortcut?: string;
  danger?: boolean;
  separator?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const menu = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const buttons = () => Array.from(menu?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    buttons()[0]?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!menu?.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!menu?.contains(document.activeElement)) return;
      if (e.key === "Escape" || e.key === "Tab") {
        if (e.key === "Escape") {
          e.stopPropagation();
          e.preventDefault();
        } else {
          // Continue normal Tab navigation (and any surrounding modal trap)
          // from the opener rather than from a button about to be removed.
          previousFocus?.focus();
        }
        onCloseRef.current();
        return;
      }
      const enabled = buttons();
      if (!enabled.length) return;
      const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const next = e.key === "Home" ? 0 : e.key === "End" ? enabled.length - 1
          : (index + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
        enabled[next]?.focus();
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) enabled[index]?.click();
      }
    };
    const timer = window.setTimeout(() => {
      window.addEventListener("mousedown", onDoc);
      // Handle menu keys before a surrounding modal sees Escape or arrows.
      window.addEventListener("keydown", onKey, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
      if (previousFocus?.isConnected && (menu?.contains(document.activeElement) || document.activeElement === document.body)) {
        previousFocus.focus();
      }
    };
  }, []);

  // keep inside viewport
  const w = Math.max(0, Math.min(220, window.innerWidth - 16));
  const h = 8 + items.length * 28;
  const left = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - h - 8));

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: w, maxHeight: Math.max(0, window.innerHeight - top - 8) }}
      className="fixed z-[60] overflow-y-auto overflow-x-hidden rounded-lg border border-border/80 bg-surface-elevated py-1 text-[12.5px] shadow-elevated"
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={`sep-${i}`} className="my-1 h-px bg-border/60" />
        ) : (
          <button
            key={it.id}
            disabled={it.disabled}
            onClick={() => {
              it.onClick?.();
              onClose();
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left",
              it.disabled
                ? "text-muted-foreground/40"
                : it.danger
                ? "text-danger hover:bg-danger/15"
                : "text-foreground hover:bg-accent"
            )}
          >
            {it.icon && <it.icon className="h-3.5 w-3.5" />}
            <span className="flex-1 truncate">{it.label}</span>
            {it.shortcut && (
              <span className="text-[10.5px] text-muted-foreground">
                {it.shortcut}
              </span>
            )}
          </button>
        )
      )}
    </div>,
    document.body
  );
}
