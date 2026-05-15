import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { copyText } from "@/lib/clipboard";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string | null;
}

// Top-level error boundary so a render crash shows a recovery panel instead of
// a blank window. The constructor / componentDidCatch pattern is the only way
// React surfaces these — hooks can't catch render-phase errors.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    // Keep this in console.error so the user can still see it via Inspect
    // Element in dev — the panel only shows the message + a copy button.
    console.error("Uncaught render error:", error, info);
  }

  private onReload = () => {
    this.setState({ error: null, componentStack: null });
  };

  private onCopyDetails = async () => {
    const { error, componentStack } = this.state;
    const text = [
      `${error?.name ?? "Error"}: ${error?.message ?? "(no message)"}`,
      "",
      error?.stack ?? "(no stack)",
      "",
      "Component stack:",
      componentStack ?? "(none)",
    ].join("\n");
    await copyText(text);
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full min-h-screen items-center justify-center bg-background p-8">
        <div className="w-full max-w-xl rounded-xl border border-rose-500/30 bg-surface-elevated p-6 shadow-elevated">
          <div className="mb-3 flex items-center gap-2 text-rose-300">
            <AlertTriangle className="h-5 w-5" />
            <h2 className="text-[15px] font-semibold">Something broke</h2>
          </div>
          <p className="mb-3 text-[13px] text-muted-foreground">
            The interface hit an unrecoverable error. You can try to recover, or
            copy the details and report them on GitHub.
          </p>
          <div className="mb-4 max-h-48 overflow-auto rounded-md border border-border/60 bg-surface/40 px-3 py-2 font-mono text-[11.5px] leading-snug text-foreground/90">
            <div className="font-semibold text-rose-300">
              {error.name}: {error.message}
            </div>
            {error.stack && (
              <pre className="mt-2 whitespace-pre-wrap break-all text-muted-foreground">
                {error.stack}
              </pre>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={this.onCopyDetails}
              className="rounded-md border border-border/70 bg-surface-muted px-3 py-1.5 text-[12px] font-medium hover:bg-accent"
            >
              Copy details
            </button>
            <button
              onClick={this.onReload}
              className="flex items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-[12px] font-medium text-brand-foreground hover:bg-brand/90"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
