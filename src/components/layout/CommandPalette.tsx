import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CornerDownLeft,
  Database,
  History as HistoryIcon,
  Moon,
  Plug,
  PlugZap,
  Plus,
  Search,
  Sparkles,
  Table2,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useLayout } from "@/store/layout";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { useTheme } from "@/components/theme/ThemeProvider";
import { useT } from "@/store/i18n";

type Item = {
  id: string;
  group: "Connections" | "Queries" | "Tables" | "Actions";
  icon: React.ElementType;
  label: string;
  hint?: string;
  badge?: string;
  run: () => void;
};

export function CommandPalette() {
  const { paletteOpen, closePalette, setActivity } = useLayout();
  const { list, status, branches, connect } = useConnections();
  const openTab = useWorkspace((s) => s.openTab);
  const { toggle: toggleTheme } = useTheme();
  const t = useT();

  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [paletteOpen]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];

    for (const c of list) {
      const s = status[c.id] ?? "disconnected";
      out.push({
        id: `open:${c.id}`,
        group: "Connections",
        icon: s === "connected" ? PlugZap : Plug,
        label: t("palette.connect_to", { name: c.name }),
        hint: c.driver.toUpperCase(),
        badge: s === "connected" ? t("palette.badge.connected") : undefined,
        run: () => {
          if (s !== "connected") void connect(c.id);
        },
      });
    }

    for (const c of list) {
      if ((status[c.id] ?? "disconnected") !== "connected") continue;
      out.push({
        id: `new-query:${c.id}`,
        group: "Queries",
        icon: Terminal,
        label: t("palette.new_query_on", { name: c.name }),
        hint: c.driver.toUpperCase(),
        run: () =>
          openTab({
            id: `query:${crypto.randomUUID()}`,
            kind: "query",
            title: "Query",
            subtitle: c.name,
            connectionId: c.id,
          }),
      });
    }

    for (const c of list) {
      const b = branches[c.id];
      if (!b) continue;
      for (const [schema, tables] of Object.entries(b.tables ?? {}) as [
        string,
        import("@/types").TreeEntry[]
      ][]) {
        for (const t of tables) {
          out.push({
            id: `table:${c.id}:${schema}:${t.name}`,
            group: "Tables",
            icon: Table2,
            label: t.name,
            hint: `${c.name} · ${schema === "_" ? "" : schema}`.trim(),
            run: () =>
              openTab({
                id: `data:${c.id}:${schema === "_" ? "" : schema}:${t.name}`,
                kind: "table-data",
                title: t.name,
                subtitle: t.kind === "view" ? "View" : "Data",
                connectionId: c.id,
                schema: schema === "_" ? undefined : schema,
                table: t.name,
              }),
          });
        }
      }
    }

    out.push(
      {
        id: "action:new-connection",
        group: "Actions",
        icon: Plus,
        label: t("palette.new_connection"),
        run: () => setActivity("connections"),
      },
      {
        id: "action:history",
        group: "Actions",
        icon: HistoryIcon,
        label: t("palette.open_history"),
        run: () => setActivity("history"),
      },
      {
        id: "action:welcome",
        group: "Actions",
        icon: Sparkles,
        label: t("palette.open_welcome"),
        run: () =>
          openTab({ id: "welcome", kind: "welcome", title: "Welcome" }),
      },
      {
        id: "action:theme",
        group: "Actions",
        icon: Moon,
        label: t("palette.toggle_theme"),
        run: () => toggleTheme(),
      }
    );

    return out;
  }, [list, status, branches, connect, openTab, setActivity, toggleTheme, t]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items.slice(0, 80);
    return items
      .map((it) => ({ it, score: score(it.label, needle) + score(it.hint ?? "", needle) * 0.3 }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 80)
      .map((x) => x.it);
  }, [items, q]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  // Global hotkey
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        useLayout.getState().togglePalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!paletteOpen) return null;

  const runSelected = () => {
    const it = filtered[idx];
    if (!it) return;
    it.run();
    closePalette();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runSelected();
    }
  };

  const groups = groupBy(filtered);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24"
      onMouseDown={(e) => e.target === e.currentTarget && closePalette()}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div className="relative flex max-h-[70vh] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border/80 bg-surface-elevated shadow-elevated">
        <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder={t("palette.placeholder")}
            className="flex-1 border-0 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground/60"
          />
          <kbd className="rounded bg-surface px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
            ESC
          </kbd>
        </div>
        <div className="max-h-[54vh] overflow-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12.5px] text-muted-foreground">
              {t("palette.no_matches")}
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.name}>
                <div className="sticky top-0 bg-surface-elevated/95 px-4 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
                  {t(`palette.group.${g.name.toLowerCase()}`)}
                </div>
                {g.items.map((it) => {
                  const i = filtered.indexOf(it);
                  const active = i === idx;
                  return (
                    <button
                      key={it.id}
                      onMouseMove={() => setIdx(i)}
                      onClick={() => {
                        it.run();
                        closePalette();
                      }}
                      className={cn(
                        "flex w-full items-center gap-3 px-4 py-2 text-left text-[13px]",
                        active ? "bg-accent" : "hover:bg-accent/60"
                      )}
                    >
                      <it.icon
                        className={cn(
                          "h-4 w-4 shrink-0",
                          active ? "text-foreground" : "text-muted-foreground"
                        )}
                      />
                      <span className="flex-1 truncate">{it.label}</span>
                      {it.badge && (
                        <span className="rounded bg-success/15 px-1.5 text-[10px] text-success">
                          {it.badge}
                        </span>
                      )}
                      {it.hint && (
                        <span className="text-[11px] text-muted-foreground">
                          {it.hint}
                        </span>
                      )}
                      {active && (
                        <CornerDownLeft className="h-3 w-3 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center gap-3 border-t border-border/70 bg-surface/40 px-4 py-1.5 text-[10.5px] text-muted-foreground">
          <span>{t("palette.hint.navigate")}</span>
          <span>{t("palette.hint.select")}</span>
          <span className="ml-auto">
            <Database className="mr-1 inline h-3 w-3" />
            rdbstudio
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}

function score(s: string, needle: string): number {
  if (!s) return 0;
  const lower = s.toLowerCase();
  const idx = lower.indexOf(needle);
  if (idx < 0) {
    // subsequence match
    let ni = 0;
    let matched = 0;
    for (let i = 0; i < lower.length && ni < needle.length; i++) {
      if (lower[i] === needle[ni]) {
        ni++;
        matched++;
      }
    }
    return ni === needle.length ? 10 + matched / lower.length : 0;
  }
  // contiguous — higher score if near start
  return 100 - idx * 0.5 + needle.length;
}

function groupBy(items: Item[]): { name: string; items: Item[] }[] {
  const out: { name: string; items: Item[] }[] = [];
  for (const it of items) {
    const g = out.find((x) => x.name === it.group);
    if (g) g.items.push(it);
    else out.push({ name: it.group, items: [it] });
  }
  const order: Item["group"][] = ["Connections", "Queries", "Tables", "Actions"];
  out.sort((a, b) => order.indexOf(a.name as Item["group"]) - order.indexOf(b.name as Item["group"]));
  return out;
}
