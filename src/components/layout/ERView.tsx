import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import type { TableDescription, WorkspaceTab } from "@/types";
import { api } from "@/lib/api";
import { ERDiagram } from "@/components/er/ERDiagram";
import { useT } from "@/store/i18n";

export function ERView({ tab }: { tab: WorkspaceTab }) {
  const connectionId = tab.connectionId!;
  const schema = tab.schema;
  const [tables, setTables] = useState<TableDescription[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await api.describeSchema(connectionId, schema, 80);
      setTables(t);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema]);

  const fkCount = tables.reduce((n, t) => n + t.foreign_keys.length, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border/70 bg-surface/30 px-3 text-[11.5px] text-muted-foreground">
        <span className="text-foreground/90">
          {tab.title}
          {schema ? ` · ${schema}` : ""}
        </span>
        {loading && <Loader2 className="h-3 w-3 animate-spin" />}
        <span>·</span>
        <span>{t("er.tables", { n: tables.length })}</span>
        <span>·</span>
        <span>{t("er.relationships", { n: fkCount })}</span>
        <div className="flex-1" />
        <button
          onClick={() => void load()}
          className="flex h-6 items-center gap-1 rounded px-1.5 hover:bg-accent hover:text-foreground"
        >
          <RefreshCw className="h-3 w-3" />
          {t("common.refresh")}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="flex h-full items-start justify-center p-6">
            <div className="max-w-lg rounded-lg border border-danger/40 bg-danger/10 p-4 text-[12.5px]">
              <div className="mb-1 flex items-center gap-2 font-medium text-danger">
                <AlertTriangle className="h-4 w-4" />
                {t("er.err")}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-foreground/90">
                {error}
              </pre>
            </div>
          </div>
        ) : loading && tables.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-[12.5px] text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("er.loading")}
          </div>
        ) : tables.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">
            {t("er.empty")}
          </div>
        ) : (
          <ERDiagram tables={tables} />
        )}
      </div>
    </div>
  );
}
