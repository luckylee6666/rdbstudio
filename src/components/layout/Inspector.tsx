import { useEffect, useState } from "react";
import { Info, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import type { TableDescription } from "@/types";
import { useT } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function Inspector() {
  const activeTab = useWorkspace((s) =>
    s.tabs.find((tab) => tab.id === s.activeTabId)
  );
  const [desc, setDesc] = useState<TableDescription | null>(null);
  const [loading, setLoading] = useState(false);
  const t = useT();

  const inspectable =
    activeTab &&
    (activeTab.kind === "table-data" || activeTab.kind === "designer") &&
    !!activeTab.connectionId &&
    !!activeTab.table;

  useEffect(() => {
    if (!inspectable || !activeTab) {
      setDesc(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .describeTable(activeTab.connectionId!, activeTab.table!, activeTab.schema)
      .then((d) => {
        if (!cancelled) setDesc(d);
      })
      .catch(() => {
        // Inspector is best-effort context, never a blocking error surface.
        if (!cancelled) setDesc(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Re-describe when the user switches tabs, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, inspectable]);

  return (
    <aside className="hidden w-[300px] shrink-0 overflow-y-auto border-l border-border/70 bg-surface/40 xl:block">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("inspector.title")}
        </div>
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        ) : (
          <Info className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </div>
      {desc ? (
        <div className="space-y-4 px-3 pb-4 text-[12.5px]">
          <Section label={t("inspector.object")}>
            <Row k={t("inspector.name")} v={desc.name} />
            {desc.schema && <Row k={t("inspector.schema")} v={desc.schema} />}
            {desc.row_estimate != null && (
              <Row
                k={t("inspector.rows")}
                v={`≈ ${desc.row_estimate.toLocaleString()}`}
              />
            )}
            {desc.size_bytes != null && (
              <Row k={t("inspector.size")} v={formatBytes(desc.size_bytes)} />
            )}
          </Section>
          <Section label={`${t("inspector.columns")} · ${desc.columns.length}`}>
            {desc.columns.map((c) => (
              <Col
                key={c.name}
                name={c.name}
                type={c.data_type}
                tag={c.is_primary_key ? "PK" : undefined}
              />
            ))}
          </Section>
          {desc.indexes.length > 0 && (
            <Section
              label={`${t("inspector.indexes")} · ${desc.indexes.length}`}
            >
              {desc.indexes.map((ix) => (
                <div
                  key={ix.name}
                  className="rounded-md bg-surface-muted/60 px-2 py-1.5"
                >
                  <div className="truncate font-medium">{ix.name}</div>
                  <div className="truncate text-muted-foreground">
                    {(ix.method ?? "").toUpperCase()}
                    {ix.method ? " " : ""}({ix.columns.join(", ")})
                    {ix.is_unique && !ix.is_primary ? " · UNIQUE" : ""}
                    {ix.is_primary ? " · PRIMARY" : ""}
                  </div>
                </div>
              ))}
            </Section>
          )}
          {desc.foreign_keys.length > 0 && (
            <Section
              label={`${t("inspector.foreign_keys")} · ${desc.foreign_keys.length}`}
            >
              {desc.foreign_keys.map((fk) => (
                <div
                  key={fk.name}
                  className="rounded-md bg-surface-muted/60 px-2 py-1.5"
                >
                  <div className="truncate font-medium">
                    {fk.columns.join(", ")}
                  </div>
                  <div className="truncate text-muted-foreground">
                    → {fk.referenced_table} ({fk.referenced_columns.join(", ")})
                  </div>
                </div>
              ))}
            </Section>
          )}
        </div>
      ) : (
        <div className="px-3 pb-4 pt-8 text-center text-[12px] text-muted-foreground">
          {t("inspector.empty")}
        </div>
      )}
    </aside>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="truncate">{v}</span>
    </div>
  );
}

function Col({ name, type, tag }: { name: string; type: string; tag?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-accent/40">
      <span className="flex-1 truncate font-mono text-[12px]">{name}</span>
      <span className="truncate text-[11px] text-muted-foreground">{type}</span>
      {tag && (
        <span className="rounded bg-brand/15 px-1 text-[10px] font-semibold text-brand">
          {tag}
        </span>
      )}
    </div>
  );
}
