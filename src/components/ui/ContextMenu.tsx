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

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    setTimeout(() => {
      window.addEventListener("mousedown", onDoc);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // keep inside viewport
  const w = 220;
  const h = 8 + items.length * 28;
  const left = Math.min(x, window.innerWidth - w - 8);
  const top = Math.min(y, window.innerHeight - h - 8);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left, top, width: w }}
      className="fixed z-[60] overflow-hidden rounded-lg border border-border/80 bg-surface-elevated py-1 text-[12.5px] shadow-elevated"
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
