import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Loader2, Plug, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { connColorValue } from "@/lib/connColors";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import type { ConnectionConfig } from "@/types";
import { Button } from "@/components/ui/Button";
import { DriverBadge } from "@/components/connection/driverIcon";

/** Shared chrome for the tool tabs (sync, search, objects, Redis tools). */
export function ToolPage({
  icon: Icon,
  title,
  description,
  actions,
  children,
  bodyClassName,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  bodyClassName?: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 bg-gradient-to-b from-surface/70 to-surface/20 px-5 py-3.5">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand ring-1 ring-inset ring-brand/25">
          <Icon className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[14px] font-semibold tracking-tight">{title}</h2>
          {description && (
            <p className="mt-0.5 truncate text-[12px] text-muted-foreground">{description}</p>
          )}
        </div>
        {actions}
      </header>
      <div className={cn("min-h-0 flex-1 overflow-auto px-5 py-4", bodyClassName)}>{children}</div>
    </div>
  );
}

export function ToolCard({
  title,
  aside,
  children,
  className,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border/70 bg-surface/50 p-4 shadow-soft", className)}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && (
            <h3 className="text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              {title}
            </h3>
          )}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function ToolField({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
        {label}
        {hint && <span className="font-normal text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** Styled native select with a consistent chevron. */
export function ToolSelect({
  className,
  children,
  leading,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { leading?: ReactNode }) {
  return (
    <div
      className={cn(
        "relative flex h-9 min-w-0 items-center rounded-md border border-border/80 bg-surface transition-colors focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-ring/30",
        props.disabled && "opacity-60",
        className
      )}
    >
      {leading && <span className="pointer-events-none flex shrink-0 items-center pl-2.5">{leading}</span>}
      <select
        {...props}
        className="h-full min-w-0 flex-1 cursor-pointer appearance-none truncate bg-transparent pl-2.5 pr-8 text-[13px] text-foreground outline-none disabled:cursor-default"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-3.5 w-3.5 text-muted-foreground" />
    </div>
  );
}

/** Pick a saved connection; selecting a disconnected one connects it. */
export function ConnectionPicker({
  value,
  onChange,
  accept,
  label,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  accept: (c: ConnectionConfig) => boolean;
  label: string;
  disabled?: boolean;
}) {
  const t = useT();
  const list = useConnections((s) => s.list);
  const status = useConnections((s) => s.status);
  const connect = useConnections((s) => s.connect);
  const [error, setError] = useState("");
  const options = useMemo(() => list.filter(accept), [list, accept]);
  const current = options.find((c) => c.id === value);
  const state = current ? status[current.id] : undefined;
  const connected = options.filter((c) => status[c.id] === "connected");
  const others = options.filter((c) => status[c.id] !== "connected");

  const connectCurrent = async (id: string) => {
    setError("");
    try {
      await connect(id);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <ToolField label={label}>
      <div className="flex items-center gap-2">
        <ToolSelect
          aria-label={label}
          className="flex-1"
          value={current?.id ?? ""}
          disabled={disabled || options.length === 0}
          leading={
            current ? (
              // Environment tag, drawn like the tree's bar so it never reads
              // as a connection-status dot.
              <span
                className="h-4 w-[3px] rounded-full"
                style={{ background: connColorValue(current.color) ?? "hsl(var(--border))" }}
              />
            ) : undefined
          }
          onChange={(e) => {
            const id = e.target.value;
            onChange(id);
            if (id && status[id] !== "connected") void connectCurrent(id);
          }}
        >
          {options.length === 0 && <option value="">{t("tool.no_connections")}</option>}
          {connected.length > 0 && (
            <optgroup label={t("query.toolbar.group_connected")}>
              {connected.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label={t("query.toolbar.group_disconnected")}>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )}
        </ToolSelect>
        {current && state !== "connected" && state !== "connecting" && (
          <Button size="md" onClick={() => void connectCurrent(current.id)} disabled={disabled}>
            <Plug className="h-3.5 w-3.5" />
            {t("common.connect")}
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex min-h-[16px] items-center gap-1.5 text-[11px]">
        {current && <DriverBadge driver={current.driver} />}
        {state === "connecting" ? (
          <span className="flex items-center gap-1 text-warning">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("tool.connecting")}
          </span>
        ) : state === "connected" ? (
          <span className="text-success">{t("tool.connected")}</span>
        ) : current ? (
          <span className="text-muted-foreground">{t("tool.not_connected")}</span>
        ) : null}
        {current?.read_only && <span className="text-warning">· {t("conn.badge.read_only")}</span>}
        {error && <span className="truncate text-danger" title={error}>· {error}</span>}
      </div>
    </ToolField>
  );
}

/** Default selection: first connected match, else first match. */
export function useDefaultConnection(accept: (c: ConnectionConfig) => boolean): string {
  const list = useConnections((s) => s.list);
  const status = useConnections((s) => s.status);
  return useMemo(() => {
    const options = list.filter(accept);
    return (options.find((c) => status[c.id] === "connected") ?? options[0])?.id ?? "";
  }, [list, status, accept]);
}

/**
 * Database (MySQL) / schema (PostgreSQL) chooser for a connected connection.
 * Empty value means the connection's default; SQLite has nothing to choose.
 */
export function SchemaPicker({
  connectionId,
  value,
  onChange,
  label,
}: {
  connectionId: string;
  value: string;
  onChange: (schema: string) => void;
  label: string;
}) {
  const t = useT();
  const cfg = useConnections((s) => s.list.find((c) => c.id === connectionId));
  const connected = useConnections((s) => s.status[connectionId] === "connected");
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    setNames([]);
    if (!connected || !cfg || cfg.driver === "sqlite" || cfg.driver === "redis") return;
    api
      .listDatabases(connectionId)
      .then((list) => {
        if (!cancelled) setNames(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!cancelled) setNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, connected, cfg]);

  if (!cfg || cfg.driver === "sqlite" || cfg.driver === "redis") return null;
  const fallback = cfg.driver === "postgres" ? "public" : cfg.database || "";
  return (
    <ToolField label={label}>
      <ToolSelect aria-label={label} value={value} disabled={!connected} onChange={(e) => onChange(e.target.value)}>
        <option value="">
          {fallback ? t("tool.schema.default_named", { name: fallback }) : t("tool.schema.default")}
        </option>
        {names
          .filter((n) => n !== fallback)
          .map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
      </ToolSelect>
    </ToolField>
  );
}

export function ToolEmpty({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: string }) {
  return (
    <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 text-center">
      <div className="grid h-10 w-10 place-items-center rounded-full bg-surface-muted text-muted-foreground">
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-[13px] font-medium text-foreground/90">{title}</div>
      {hint && <div className="max-w-sm text-[12px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
