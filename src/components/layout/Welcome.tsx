import { Database, Plus, Terminal, Workflow, FileDown } from "lucide-react";
import { useWorkspace } from "@/store/workspace";
import { useLayout } from "@/store/layout";
import { useT } from "@/store/i18n";

export function Welcome() {
  const openTab = useWorkspace((s) => s.openTab);
  const setActivity = useLayout((s) => s.setActivity);
  const openPalette = useLayout((s) => s.openPalette);
  const t = useT();

  const actions = [
    {
      icon: Database,
      titleKey: "welcome.action.new_connection",
      descKey: "welcome.action.new_connection.desc",
      accent: "from-sky-500/20 to-sky-500/0 text-sky-300",
      run: () => setActivity("connections"),
    },
    {
      icon: Terminal,
      titleKey: "welcome.action.new_query",
      descKey: "welcome.action.new_query.desc",
      accent: "from-emerald-500/20 to-emerald-500/0 text-emerald-300",
      run: () =>
        openTab({
          id: `query:${crypto.randomUUID()}`,
          kind: "query",
          title: t("welcome.action.new_query"),
          subtitle: "Untitled",
        }),
    },
    {
      icon: Workflow,
      titleKey: "welcome.action.new_er",
      descKey: "welcome.action.new_er.desc",
      accent: "from-violet-500/20 to-violet-500/0 text-violet-300",
      run: () => openPalette(),
    },
    {
      icon: FileDown,
      titleKey: "welcome.action.import",
      descKey: "welcome.action.import.desc",
      accent: "from-amber-500/20 to-amber-500/0 text-amber-300",
      run: () => setActivity("connections"),
    },
  ];

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex h-full max-w-4xl flex-col justify-center gap-10 px-10 py-12">
        <div>
          <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-border/80 bg-surface-elevated/60 px-3 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
            {t("welcome.badge")}
          </div>
          <h1 className="text-4xl font-semibold tracking-tight">
            {t("welcome.headline")}
          </h1>
          <p className="mt-3 max-w-xl text-[15px] text-muted-foreground">
            {t("welcome.subhead")}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {actions.map((a) => (
            <button
              key={a.titleKey}
              onClick={a.run}
              className="group relative overflow-hidden rounded-xl border border-border/70 bg-surface-elevated/60 p-4 text-left transition-colors hover:border-border hover:bg-surface-elevated"
            >
              <div
                className={`pointer-events-none absolute -right-10 -top-10 h-40 w-40 rounded-full bg-gradient-to-br ${a.accent} blur-2xl opacity-60 transition-opacity group-hover:opacity-100`}
              />
              <div className="relative flex items-start gap-3">
                <div className="grid h-9 w-9 place-items-center rounded-lg bg-accent/70 text-foreground">
                  <a.icon className="h-4 w-4" />
                </div>
                <div className="flex-1">
                  <div className="flex items-center gap-2 font-medium">
                    {t(a.titleKey)}
                    <Plus className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-60" />
                  </div>
                  <div className="mt-1 text-[12.5px] text-muted-foreground">
                    {t(a.descKey)}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-border/70 bg-surface-elevated/40 p-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("welcome.shortcuts")}
          </div>
          <div className="grid grid-cols-3 gap-y-2 text-[13px] text-muted-foreground">
            <Shortcut keys={["⌘", "K"]} label={t("welcome.shortcut.palette")} />
            <Shortcut keys={["⌘", "T"]} label={t("welcome.shortcut.new_query")} />
            <Shortcut keys={["⌘", "↵"]} label={t("welcome.shortcut.run")} />
            <Shortcut keys={["⌘", "B"]} label={t("welcome.shortcut.sidebar")} />
            <Shortcut keys={["⌘", "/"]} label={t("welcome.shortcut.theme")} />
            <Shortcut keys={["⌘", "W"]} label={t("welcome.shortcut.close_tab")} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-0.5">
        {keys.map((k) => (
          <kbd
            key={k}
            className="rounded bg-surface px-1.5 py-0.5 text-[11px] font-medium text-foreground shadow-soft"
          >
            {k}
          </kbd>
        ))}
      </div>
      <span>{label}</span>
    </div>
  );
}
