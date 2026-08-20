import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// Module-level count of mounted-open modals so global shortcut handlers
// (AppShell) can stand down while a dialog owns the keyboard — otherwise
// ⌘W "close this dialog" muscle-memory closes the tab *behind* the dialog.
let openModalCount = 0;
const modalStack: symbol[] = [];

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

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
  const dialogRef = useRef<HTMLDivElement>(null);
  const modalToken = useRef(Symbol("modal"));
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const token = modalToken.current;
    openModalCount++;
    modalStack.push(token);
    previousFocus.current = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []
      ).filter((element) => element.getClientRects().length > 0);

    const onKey = (e: KeyboardEvent) => {
      if (modalStack.at(-1) !== token) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const frame = requestAnimationFrame(() => {
      if (!dialogRef.current?.contains(document.activeElement)) {
        focusable()[0]?.focus() ?? dialogRef.current?.focus();
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      openModalCount--;
      const index = modalStack.lastIndexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      window.removeEventListener("keydown", onKey);
      const restore = previousFocus.current;
      requestAnimationFrame(() => {
        if (restore?.isConnected) restore.focus();
      });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        className={cn(
          "relative flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden rounded-xl border border-border/80 sm:max-h-[88dvh]",
          "bg-surface-elevated shadow-elevated"
        )}
        style={{ width, maxWidth: "calc(100vw - 2rem)" }}
        role="dialog"
        tabIndex={-1}
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
