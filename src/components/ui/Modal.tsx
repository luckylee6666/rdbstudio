import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// Module-level count of mounted-open modals so global shortcut handlers
// (AppShell) can stand down while a dialog owns the keyboard — otherwise
// ⌘W "close this dialog" muscle-memory closes the tab *behind* the dialog.
let openModalCount = 0;

export function anyModalOpen(): boolean {
  return openModalCount > 0;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
  closeLabel = "Close",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  closeLabel?: string;
}) {
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    openModalCount++;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      openModalCount--;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={cn(
          "relative flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-xl border border-border/80 sm:max-h-[88dvh]",
          "bg-surface-elevated shadow-elevated"
        )}
        style={{ width, maxWidth: "calc(100vw - 2rem)" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
          <h2 id={titleId} className="text-[14px] font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`${closeLabel}: ${title}`}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-surface/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
