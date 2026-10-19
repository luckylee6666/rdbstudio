import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, FileCode2, FolderClosed, FolderOpen, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { useConnections } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { useT } from "@/store/i18n";
import { cn } from "@/lib/cn";
import { ContextMenu } from "@/components/ui/ContextMenu";

export interface SchemaObject {
  kind: string; name: string; schema?: string | null; table?: string | null; identity?: string | null;
}
interface Catalog { objects: SchemaObject[]; truncated: boolean }
const KINDS = ["function", "procedure", "trigger", "event", "sequence"];

export function SchemaObjectTree({ connectionId, schema }: { connectionId: string; schema?: string }) {
  const t = useT();
  const filter = useConnections((s) => s.treeFilter).trim().toLowerCase();
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [context, setContext] = useState<{ x: number; y: number; object: SchemaObject } | null>(null);
  const effectiveOpen = open || !!filter;

  useEffect(() => {
    if (!effectiveOpen) return;
    let cancelled = false;
    setLoading(true); setError(""); setCatalog(null);
    void invoke<Catalog>("list_schema_objects", { id: connectionId, schema: schema ?? null }).then((next) => {
      if (!cancelled) setCatalog(next);
    }).catch((cause) => { if (!cancelled) setError(String(cause)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [connectionId, schema, effectiveOpen, generation]);

  async function openDefinition(object: SchemaObject) {
    const key = JSON.stringify(object);
    if (reading) return;
    setReading(key); setError("");
    try {
      const sql = await invoke<string>("get_schema_object_definition", { id: connectionId, object });
      const id = `query:${crypto.randomUUID()}`;
      sessionStorage.setItem(`rdb:sql:${id}`, sql);
      useWorkspace.getState().openTab({ id, kind: "query", title: `${object.name} · DDL`, connectionId, subtitle: object.schema ?? undefined });
    } catch (cause) { setError(String(cause)); }
    finally { setReading(null); }
  }
  function openManager(object: SchemaObject) {
    if (object.kind !== "event" && object.kind !== "sequence") return;
    useWorkspace.getState().openTab({
      id: `objects:${JSON.stringify([connectionId, object.schema ?? "", object.kind, object.name])}`,
      kind: "objects", title: object.name, connectionId, schema: object.schema ?? schema,
      objectKind: object.kind, objectName: object.name,
    });
  }
  const objects = catalog?.objects.filter((object) => !filter || `${object.name} ${object.identity ?? ""} ${object.table ?? ""}`.toLowerCase().includes(filter)) ?? [];
  return <div className="mt-0.5">
    <div className="flex items-center">
      <button className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12.5px] text-muted-foreground hover:bg-accent/50"
        onClick={() => setOpen((value) => !value)} aria-expanded={effectiveOpen}>
        <ChevronRight className={cn("h-3 w-3 shrink-0", effectiveOpen && "rotate-90")} />
        {effectiveOpen ? <FolderOpen className="h-3.5 w-3.5 shrink-0" /> : <FolderClosed className="h-3.5 w-3.5 shrink-0" />}
        {t("object_tree.title")}
        {catalog && <span className="ml-auto text-[11px]">{objects.length}</span>}
      </button>
      {effectiveOpen && <button title={t("common.refresh")} aria-label={t("object_tree.refresh")} disabled={loading}
        className="grid h-6 w-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
        onClick={() => setGeneration((value) => value + 1)}><RefreshCw className="h-3 w-3" /></button>}
    </div>
    {effectiveOpen && <div className="ml-4 space-y-1 border-l border-border/40 pl-1 text-[11px]">
      {loading && <div className="flex items-center gap-1.5 p-2 text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t("common.loading")}</div>}
      {error && <p role="alert" className="break-words px-2 py-1 text-danger">{error}</p>}
      {catalog?.truncated && <p className="px-2 text-warning">{t("object_tree.truncated")}</p>}
      {!loading && catalog && objects.length === 0 && <p className="px-2 py-1 text-muted-foreground">{t("object_tree.empty")}</p>}
      {KINDS.map((kind) => {
        const entries = objects.filter((object) => object.kind === kind);
        if (!entries.length) return null;
        return <details key={`${kind}:${filter}`} open className="group">
          <summary className="cursor-pointer rounded px-2 py-1 text-muted-foreground hover:bg-accent/50">{t(`object_tree.${kind}`)} · {entries.length}</summary>
          {entries.map((object) => {
            const key = JSON.stringify(object);
            const name = object.identity != null ? `${object.name}(${object.identity})` : object.table ? `${object.name} · ${object.table}` : object.name;
            return <button key={key} title={name} disabled={reading !== null}
              onContextMenu={(event) => {
                event.preventDefault();
                setContext({ x: event.clientX, y: event.clientY, object });
              }}
              onDoubleClick={() => void openDefinition(object)} onKeyDown={(event) => {
                if (event.repeat) return;
                if (event.key === " ") {
                  event.preventDefault();
                  void openDefinition(object);
                } else if (event.key === "Enter") {
                  void openDefinition(object);
                }
              }}
              className="ml-2 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] text-foreground/85 hover:bg-accent/50 disabled:opacity-60">
              {reading === key ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <FileCode2 className="h-3.5 w-3.5 shrink-0 text-brand" />}
              <span className="truncate">{name}</span>
            </button>;
          })}
        </details>;
      })}
    </div>}
    {context && <ContextMenu x={context.x} y={context.y} onClose={() => setContext(null)} items={[
      { id: "definition", label: t("tree.show_ddl"), icon: FileCode2, onClick: () => void openDefinition(context.object) },
      ...(context.object.kind === "event" || context.object.kind === "sequence" ? [{
        id: "manage", label: t("object_tree.manage"), icon: Settings2, onClick: () => openManager(context.object),
      }] : []),
    ]} />}
  </div>;
}
