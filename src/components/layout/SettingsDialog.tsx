import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Database,
  Globe,
  Loader2,
  Moon,
  Power,
  ShieldOff,
  Sun,
  Trash2,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useI18n, useT } from "@/store/i18n";
import { useConnections } from "@/store/connections";
import { toast } from "@/store/toasts";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { McpStatus } from "@/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: Props) {
  const t = useT();
  const { theme, set: setTheme } = useTheme();
  const { lang, setLang } = useI18n();
  const connections = useConnections((s) => s.list);

  const [version, setVersion] = useState<string>("");
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setCleared(false);
      return;
    }
    void api.appVersion().then(setVersion).catch(() => setVersion("?"));
    void api.mcpStatus().then(setMcpStatus).catch(() => setMcpStatus(null));
  }, [open]);

  const updateMcp = async (action: "start" | "stop" | "revoke") => {
    setMcpBusy(true);
    try {
      const next =
        action === "start"
          ? await api.startMcp()
          : action === "stop"
            ? await api.stopMcp()
            : await api.revokeMcpAuthorizations();
      setMcpStatus(next);
    } catch (error) {
      toast.error(t("settings.mcp.failed"), String(error));
    } finally {
      setMcpBusy(false);
    }
  };

  const doClearHistory = async () => {
    setClearing(true);
    try {
      await api.clearHistory();
      setCleared(true);
    } catch (e) {
      toast.error(t("settings.history.failed"), String(e));
    } finally {
      setClearing(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={clearing || mcpBusy}
      title={t("settings.title")}
      width={560}
      footer={
        <>
          <div className="mr-auto text-[11.5px] text-muted-foreground">
            rdbstudio · v{version || "…"}
          </div>
          <Button variant="primary" onClick={onClose} disabled={clearing || mcpBusy}>
            {t("common.done")}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <Section title={t("settings.appearance")}>
          <Row label={t("settings.theme")}>
            <ToggleGroup
              value={theme}
              options={[
                { value: "dark", label: t("settings.theme.dark"), icon: Moon },
                { value: "light", label: t("settings.theme.light"), icon: Sun },
              ]}
              onChange={(v) => setTheme(v as "dark" | "light")}
            />
          </Row>
          <Row label={t("settings.language")}>
            <ToggleGroup
              value={lang}
              options={[
                { value: "zh", label: "中文" },
                { value: "en", label: "English" },
              ]}
              onChange={(v) => setLang(v as "zh" | "en")}
              icon={Globe}
            />
          </Row>
        </Section>

        <Section title={t("settings.data")}>
          <Row label={t("settings.connections")} hint={t("settings.connections.hint")}>
            <span className="rounded-md bg-surface-muted px-2 py-1 text-[12px] tabular-nums">
              <Database className="mr-1 inline h-3 w-3 text-muted-foreground" />
              {connections.length}
            </span>
          </Row>
          <Row label={t("settings.history")} hint={t("settings.history.hint")}>
            <Button
              onClick={() => setConfirmOpen(true)}
              disabled={clearing}
              className={cn(cleared && "border-success/40 text-success")}
            >
              {clearing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("common.applying")}
                </>
              ) : cleared ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {t("settings.history.cleared")}
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("settings.history.clear")}
                </>
              )}
            </Button>
          </Row>
        </Section>

        <Section title={t("settings.mcp")}>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2.5">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-brand/10 text-brand">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[13px] font-medium">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        mcpStatus?.running ? "bg-success" : "bg-muted-foreground/50"
                      )}
                    />
                    {mcpStatus?.running
                      ? t("settings.mcp.running")
                      : t("settings.mcp.stopped")}
                  </div>
                  <div className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">
                    {t("settings.mcp.hint")}
                  </div>
                  {mcpStatus?.url && (
                    <div className="mt-1 max-w-[300px] truncate font-mono text-[10.5px] text-muted-foreground">
                      {mcpStatus.url}
                    </div>
                  )}
                </div>
              </div>
              <Button
                onClick={() => void updateMcp(mcpStatus?.running ? "stop" : "start")}
                disabled={mcpBusy}
              >
                {mcpBusy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Power className="h-3.5 w-3.5" />
                )}
                {mcpStatus?.running ? t("settings.mcp.stop") : t("settings.mcp.start")}
              </Button>
            </div>

            {(mcpStatus?.authorization_count ?? 0) > 0 && (
              <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-2.5">
                <span className="text-[11.5px] text-muted-foreground">
                  {t("settings.mcp.grants", {
                    count: mcpStatus?.authorization_count ?? 0,
                  })}
                </span>
                <Button
                  onClick={() => void updateMcp("revoke")}
                  disabled={mcpBusy}
                >
                  <ShieldOff className="h-3.5 w-3.5" />
                  {t("settings.mcp.revoke")}
                </Button>
              </div>
            )}
          </div>
        </Section>

        <Section title={t("settings.shortcuts")}>
          <ShortcutList />
        </Section>

        <Section title={t("settings.about")}>
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            {t("settings.about.body")}
          </p>
        </Section>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t("settings.history.clear")}
        message={t("settings.history.confirm")}
        confirmLabel={t("settings.history.clear")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => void doClearHistory()}
        onClose={() => setConfirmOpen(false)}
      />
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="space-y-2 rounded-lg border border-border/70 bg-surface/40 p-3">
        {children}
      </div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        {hint && (
          <div className="text-[11.5px] text-muted-foreground">{hint}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// Documents the keyboard shortcuts the app responds to. Source of truth lives
// here so it can't drift from the Settings dialog — when adding a new binding,
// add it both here and to its handler.
function ShortcutList() {
  const t = useT();
  // navigator.platform is deprecated but still the most reliable signal in
  // an offline desktop app — `userAgentData` isn't supported in WKWebView yet.
  // Falls back to userAgent on Webkit and Linux where platform is empty.
  const isMac = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    const haystack =
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      navigator.platform || navigator.userAgent || "";
    return /Mac|iPhone|iPad/i.test(haystack);
  }, []);
  const mod = isMac ? "⌘" : "Ctrl";
  const shift = isMac ? "⇧" : "Shift";
  const enter = isMac ? "↵" : "Enter";

  const rows: { keys: string; label: string }[] = [
    { keys: `${mod}${enter}`, label: t("settings.shortcut.run") },
    { keys: `${mod}${shift}F`, label: t("settings.shortcut.format") },
    { keys: `${mod}K`, label: t("settings.shortcut.palette") },
    { keys: `${mod}T`, label: t("settings.shortcut.new_tab") },
    { keys: `${mod}W`, label: t("settings.shortcut.close_tab") },
    { keys: `${mod}F`, label: t("settings.shortcut.find") },
    { keys: "Esc", label: t("settings.shortcut.escape") },
  ];
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {rows.map((r) => (
        <div
          key={r.label}
          className="flex items-center justify-between gap-3 rounded-md px-1 py-1 text-[12.5px]"
        >
          <span className="min-w-0 truncate text-foreground/85">
            {r.label}
          </span>
          <kbd className="shrink-0 rounded border border-border/70 bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground">
            {r.keys}
          </kbd>
        </div>
      ))}
    </div>
  );
}

function ToggleGroup({
  value,
  options,
  onChange,
  icon: GroupIcon,
}: {
  value: string;
  options: { value: string; label: string; icon?: React.ElementType }[];
  onChange: (v: string) => void;
  icon?: React.ElementType;
}) {
  return (
    <div className="flex items-center rounded-md border border-border/70 bg-surface p-0.5">
      {GroupIcon && (
        <GroupIcon className="mx-1.5 h-3.5 w-3.5 text-muted-foreground" />
      )}
      {options.map((o) => {
        const active = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded px-2.5 text-[12px] transition-colors",
              active
                ? "bg-brand text-brand-foreground shadow-soft"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
