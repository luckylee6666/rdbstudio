import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { useToasts, type ToastKind } from "@/store/toasts";
import { cn } from "@/lib/cn";

const ICONS: Record<ToastKind, React.ElementType> = {
  info: Info,
  success: CheckCircle2,
  error: AlertTriangle,
};

const STYLES: Record<ToastKind, string> = {
  info: "border-border/70 bg-surface-elevated text-foreground",
  success:
    "border-success/40 bg-success/10 text-foreground",
  error:
    "border-rose-500/40 bg-rose-500/10 text-foreground",
};

const ICON_STYLES: Record<ToastKind, string> = {
  info: "text-muted-foreground",
  success: "text-success",
  error: "text-rose-400",
};

// Renders the global toast stack in the top-right of the viewport. Driven by
// the toasts zustand store; consumers push messages via `toast.error(...)` /
// `toast.success(...)` from anywhere — no hook needed.
export function Toaster() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);

  return createPortal(
    <div
      // pointer-events-none on the wrapper lets clicks pass through the gap
      // between toasts; each toast re-enables them for itself.
      className="pointer-events-none fixed right-4 top-14 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      role="region"
      aria-label="Notifications"
      aria-live="polite"
    >
      {items.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div
            key={t.id}
            className={cn(
              "pointer-events-auto flex gap-2 rounded-md border px-3 py-2 shadow-elevated backdrop-blur",
              STYLES[t.kind]
            )}
            role={t.kind === "error" ? "alert" : "status"}
          >
            <Icon
              className={cn("mt-0.5 h-4 w-4 shrink-0", ICON_STYLES[t.kind])}
            />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium leading-snug">
                {t.title}
              </div>
              {t.detail && (
                <div className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground">
                  {t.detail}
                </div>
              )}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>,
    document.body
  );
}
