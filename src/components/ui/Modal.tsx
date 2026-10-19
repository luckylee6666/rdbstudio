import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/store/i18n";

// Module-level count of mounted-open modals so global shortcut handlers
// (AppShell) can stand down while a dialog owns the keyboard — otherwise
// ⌘W "close this dialog" muscle-memory closes the tab *behind* the dialog.
interface ModalEntry {
  token: symbol;
  dialog: HTMLDivElement;
  restore: HTMLElement[];
}
const modalStack: ModalEntry[] = [];

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "summary",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function anyModalOpen(): boolean {
  return modalStack.length > 0;
}

function focusableIn(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.tabIndex >= 0 && !element.matches(":disabled")
      && !element.closest("[hidden], [inert], [aria-hidden='true']")
      && getComputedStyle(element).visibility !== "hidden"
      && element.getClientRects().length > 0
  );
}

function focusFirst(dialog: HTMLElement) {
  (focusableIn(dialog)[0] ?? dialog).focus();
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 520,
  closeLabel,
  closeDisabled = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  closeLabel?: string;
  /** Prevent Escape, backdrop and close-button dismissal during an operation. */
  closeDisabled?: boolean;
}) {
  const t = useT();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const modalToken = useRef(Symbol("modal"));
  const onCloseRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);
  onCloseRef.current = onClose;
  closeDisabledRef.current = closeDisabled;

  useEffect(() => {
    if (!open) return;
    const token = modalToken.current;
    const dialog = dialogRef.current!;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Retain the opener chain so closing parent and child together can still
    // restore focus outside both removed dialogs.
    const entry: ModalEntry = {
      token, dialog,
      restore: [...(previous ? [previous] : []), ...(modalStack.at(-1)?.restore ?? [])],
    };
    modalStack.push(entry);

    const onKey = (e: KeyboardEvent) => {
      if (modalStack.at(-1)?.token !== token || e.defaultPrevented || e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!closeDisabledRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const items = focusableIn(dialog);
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!items.includes(document.activeElement as HTMLElement)) {
        // Disabled/removed controls and portaled menus can temporarily leave
        // focus on the container or outside it. Resume inside this dialog.
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const frame = requestAnimationFrame(() => {
      if (modalStack.at(-1)?.token === token && !dialog.contains(document.activeElement)) {
        focusFirst(dialog);
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      const wasTop = modalStack.at(-1)?.token === token;
      const index = modalStack.findIndex((item) => item.token === token);
      if (index >= 0) modalStack.splice(index, 1);
      window.removeEventListener("keydown", onKey);
      requestAnimationFrame(() => {
        if (!wasTop) return;
        const top = modalStack.at(-1)?.dialog;
        const restore = entry.restore.find((element) => element.isConnected
          && (!top || top.contains(element)) && !element.matches(":disabled")
          && !element.closest("[hidden], [inert], [aria-hidden='true']"));
        if (restore) restore.focus();
        else if (top && !top.contains(document.activeElement)) focusFirst(top);
      });
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={() => {
          if (!closeDisabled) onClose();
        }}
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
            onClick={() => {
              if (!closeDisabled) onClose();
            }}
            disabled={closeDisabled}
            aria-label={`${closeLabel ?? t("common.close")}: ${title}`}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-surface/40 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
