import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { sourceWidthKey, type QueryDesign } from "@/lib/queryBuilder";

const empty = new Map<string, number>();

export function useUnionWidths(query: QueryDesign, connectionId: string, connected: boolean, revision: number) {
  const keys = query.unions?.length ? [...new Set([query, ...query.unions.map(a => a.select)]
    .filter(s => !s.columns.length).flatMap(s => s.sources.map(sourceWidthKey)))].sort() : [];
  const request = keys.length && connected ? JSON.stringify([connectionId, revision, keys]) : "";
  const job = useMemo(() => ({ request }), [request]);
  const [result, setResult] = useState<{ job: typeof job; widths: Map<string, number> } | null>(null);
  useEffect(() => {
    if (!job.request) return;
    const [id, , sources]: [string, number, string[]] = JSON.parse(job.request);
    const widths = new Map<string, number>();
    let current = true;
    const finish = () => {
      if (!current) return;
      current = false;
      setResult({ job, widths });
    };
    const timer = setTimeout(finish, 5000);
    async function read() {
      for (const key of sources) {
        if (!current) break;
        const [schema, table]: [string | null, string] = JSON.parse(key);
        try {
          const width = await api.queryBuilderStarWidth(id, table, schema ?? undefined);
          if (current && width != null && width > 0) widths.set(key, width);
        } catch { /* The editor can still open a query with unverified projections. */ }
      }
      clearTimeout(timer);
      finish();
    }
    void read();
    return () => { current = false; clearTimeout(timer); };
  }, [job]);
  const pending = !!request && result?.job !== job;
  const widths = result?.job === job ? result.widths : empty;
  return { widths, pending, unknown: keys.length > widths.size && !pending };
}
