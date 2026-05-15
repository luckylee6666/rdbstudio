import { GitBranch, Plug, Wifi } from "lucide-react";

export function StatusBar() {
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border/70 bg-surface/60 px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <Plug className="h-3 w-3" />
        Local Postgres
      </span>
      <span className="flex items-center gap-1">
        <GitBranch className="h-3 w-3" />
        public
      </span>
      <span className="flex items-center gap-1">
        <Wifi className="h-3 w-3 text-success" />
        connected · 12ms
      </span>
      <div className="flex-1" />
      <span>UTF-8</span>
      <span>·</span>
      <span>LF</span>
      <span>·</span>
      <span>SQL</span>
    </footer>
  );
}
