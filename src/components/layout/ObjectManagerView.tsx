import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Braces,
  CalendarClock,
  FileCode2,
  KeyRound,
  ListOrdered,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { CodeMirrorEditor } from "@/components/editor/CodeMirror";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import { ToolField, ToolSelect } from "@/components/tools/ToolKit";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useConnections } from "@/store/connections";
import { useT } from "@/store/i18n";
import { toast } from "@/store/toasts";
import type { DriverKind } from "@/types";
import { SequenceManager } from "./SequenceManager";
import { MySqlEventManager } from "./MySqlEventManager";

interface ManagedObject {
  kind: string;
  schema?: string | null;
  name: string;
  table?: string | null;
  definition?: string | null;
  drop_sql?: string | null;
  identity?: string | null;
}

function objectIdentity(item: ManagedObject): string {
  return JSON.stringify([item.kind, item.schema ?? "", item.name, item.table ?? "", item.identity ?? "", item.drop_sql ?? ""]);
}

function objectLabel(item: ManagedObject): string {
  return item.identity != null ? `${item.name}(${item.identity})` : item.name;
}
interface ManagedUser {
  name: string;
  host?: string | null;
  grants: string[];
}
interface ObjectCatalog {
  objects: ManagedObject[];
  users: ManagedUser[];
  supported: string[];
}
type ObjectKind = "trigger" | "function" | "procedure";
type Scope = "table" | "database" | "schema";

const KIND_ICONS: Record<ObjectKind, LucideIcon> = {
  trigger: Zap,
  function: Braces,
  procedure: Workflow,
};
const MYSQL_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES", "EXECUTE", "TRIGGER", "CREATE VIEW", "SHOW VIEW", "ALL PRIVILEGES"];
const PG_TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "ALL PRIVILEGES"];
const PG_DATABASE_PRIVILEGES = ["CREATE", "CONNECT", "TEMPORARY", "ALL PRIVILEGES"];
const PG_SCHEMA_PRIVILEGES = ["USAGE", "CREATE", "ALL PRIVILEGES"];

/** Starter definition for the "New" button, per engine dialect. */
function template(kind: ObjectKind, driver: DriverKind, table?: string): string {
  const target = table ?? "my_table";
  if (kind === "trigger") {
    if (driver === "mysql")
      return `CREATE TRIGGER trg_${target}_bi BEFORE INSERT ON \`${target}\`\nFOR EACH ROW\nBEGIN\n  -- SET NEW.updated_at = NOW();\nEND`;
    if (driver === "postgres")
      return `-- The trigger function must already exist (CREATE FUNCTION ... RETURNS trigger).\nCREATE TRIGGER trg_${target}_bi\nBEFORE INSERT ON "${target}"\nFOR EACH ROW EXECUTE FUNCTION my_trigger_fn();`;
    return `CREATE TRIGGER trg_${target}_ai AFTER INSERT ON "${target}"\nBEGIN\n  -- UPDATE other_table SET ... WHERE id = NEW.id;\nEND;`;
  }
  if (kind === "function") {
    if (driver === "mysql")
      return "CREATE FUNCTION fn_example(p INT) RETURNS INT\nDETERMINISTIC\nRETURN p + 1";
    return "CREATE FUNCTION fn_example(p integer) RETURNS integer\nLANGUAGE sql IMMUTABLE\nAS $$ SELECT p + 1 $$;";
  }
  if (driver === "mysql") return "CREATE PROCEDURE sp_example(IN p INT)\nBEGIN\n  SELECT p;\nEND";
  return "CREATE PROCEDURE sp_example(p integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RAISE NOTICE 'value: %', p;\nEND $$;";
}

export function ObjectManagerView(props: {
  connectionId: string;
  schema?: string | null;
  driver: DriverKind;
  readOnly?: boolean;
  /** Table designer mode: only this table's triggers, no user management. */
  table?: string;
  initialKind?: "event" | "sequence";
  initialName?: string;
}) {
  const t = useT();
  const { connectionId, schema, driver, readOnly, table } = props;
  const [catalog, setCatalog] = useState<ObjectCatalog>({ objects: [], users: [], supported: [] });
  const [section, setSection] = useState<"objects" | "users" | "event" | "sequence">(
    !table && props.initialKind === "event" && driver === "mysql" ? "event"
      : !table && props.initialKind === "sequence" && driver === "postgres" ? "sequence" : "objects"
  );
  const [kind, setKind] = useState<ObjectKind>("trigger");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<ManagedObject | null>(null);
  const [definition, setDefinition] = useState("");
  const [busy, setBusy] = useState(false);
  const [replaceConfirm, setReplaceConfirm] = useState(false);
  const [pendingDrop, setPendingDrop] = useState<ManagedObject | null>(null);
  const [pendingUser, setPendingUser] = useState<ManagedUser | null>(null);
  const loadGeneration = useRef(0);
  const operationRunning = useRef(false);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setBusy(true);
    try {
      const result = await invoke<ObjectCatalog>("list_managed_objects", {
        id: connectionId,
        schema: schema ?? null,
        table: table ?? null,
      });
      if (generation !== loadGeneration.current) return;
      setCatalog(result);
      setSelected((old) => (old ? result.objects.find((x) => objectIdentity(x) === objectIdentity(old)) ?? null : null));
    } catch (e) {
      if (generation === loadGeneration.current) toast.error(t("objects.failed"), String(e));
    } finally {
      if (generation === loadGeneration.current) setBusy(false);
    }
  }, [connectionId, schema, table, t]);

  useEffect(() => {
    if (section === "objects" || section === "users") void load();
    return () => { loadGeneration.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, table, section]);

  const kinds = useMemo(
    () =>
      (["trigger", "function", "procedure"] as const).filter(
        (k) => catalog.supported.includes(k) && (!table || k === "trigger")
      ),
    [catalog.supported, table]
  );
  useEffect(() => {
    if (kinds.length > 0 && !kinds.includes(kind)) setKind(kinds[0]);
  }, [kinds, kind]);

  const objects = catalog.objects.filter(
    (x) =>
      x.kind.toLowerCase() === kind &&
      (!table || x.table === table) &&
      x.name.toLowerCase().includes(filter.trim().toLowerCase())
  );
  const countOf = (k: ObjectKind) =>
    catalog.objects.filter((x) => x.kind.toLowerCase() === k && (!table || x.table === table)).length;

  const run = async (command: string, args: Record<string, unknown>) => {
    if (operationRunning.current || readOnly) return false;
    operationRunning.current = true;
    setBusy(true);
    try {
      await invoke(command, args);
      toast.success(t("objects.done"));
      await load();
      return true;
    } catch (e) {
      toast.error(t("objects.failed"), String(e));
      return false;
    } finally {
      operationRunning.current = false;
      setBusy(false);
    }
  };

  const startNew = () => {
    setSelected(null);
    setDefinition(template(kind, driver, table));
  };
  const select = (item: ManagedObject) => {
    setSelected(item);
    setDefinition(item.definition ?? "");
  };
  const applyDefinition = () => {
    if (!definition.trim() || readOnly || busy || operationRunning.current) return;
    if (selected?.definition && selected.drop_sql) {
      setReplaceConfirm(true);
      return;
    }
    void run("apply_managed_object_definition", { id: connectionId, definition }).then((ok) => {
      if (ok) setDefinition("");
    });
  };

  const usersSupported = !table && catalog.supported.includes("user");

  return (
    <div className="object-tool flex h-full min-h-0 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 bg-surface/30 px-3">
        {!table && (
          <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg border border-border/60 bg-background/40 p-0.5">
            <SegButton active={section === "objects"} disabled={busy} onClick={() => setSection("objects")}>
              <FileCode2 className="h-3.5 w-3.5" />
              {t("objects.objects")}
              <span className="text-[10.5px] opacity-70">{catalog.objects.length}</span>
            </SegButton>
            {driver === "mysql" && <SegButton active={section === "event"} disabled={busy} onClick={() => setSection("event")}>
              <CalendarClock className="h-3.5 w-3.5" />{t("objects.events")}
            </SegButton>}
            {driver === "postgres" && <SegButton active={section === "sequence"} disabled={busy} onClick={() => setSection("sequence")}>
              <ListOrdered className="h-3.5 w-3.5" />{t("objects.sequences")}
            </SegButton>}
            <SegButton
              active={section === "users"}
              disabled={busy || !usersSupported}
              onClick={() => setSection("users")}
            >
              <Users className="h-3.5 w-3.5" />
              {t("objects.users")}
              {usersSupported && <span className="text-[10.5px] opacity-70">{catalog.users.length}</span>}
            </SegButton>
          </div>
        )}
        {readOnly && (
          <span className="ml-2 rounded-md bg-warning/15 px-2 py-0.5 text-[11px] text-warning">
            {t("objects.read_only")}
          </span>
        )}
        <div className="flex-1" />
        {(section === "objects" || section === "users") && <button
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          disabled={busy}
          onClick={() => void load()}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", busy && "animate-spin")} />
        </button>}
      </div>

      {section === "objects" ? (
        <div className="object-tool-layout min-h-0 flex-1">
          <aside className="flex min-h-0 flex-col border-r border-border/70 bg-surface/20">
            <div className="space-y-2 border-b border-border/60 p-3">
              {kinds.length > 1 && (
                <div className="grid grid-cols-3 gap-0.5 rounded-lg border border-border/60 bg-background/40 p-0.5">
                  {kinds.map((k) => {
                    const Icon = KIND_ICONS[k];
                    return (
                      <SegButton
                        key={k}
                        active={kind === k}
                        onClick={() => {
                          setKind(k);
                          setSelected(null);
                          setDefinition("");
                        }}
                        className="justify-center px-1"
                      >
                        <Icon className="h-3 w-3" />
                        {t(`objects.kind.${k}`)}
                        <span className="text-[10px] opacity-60">{countOf(k)}</span>
                      </SegButton>
                    );
                  })}
                </div>
              )}
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder={t("objects.filter")}
                  className="h-8 pl-8 text-[12.5px]"
                />
              </div>
            </div>
            <div className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
              {objects.map((item) => {
                const Icon = KIND_ICONS[kind];
                const active = selected != null && objectIdentity(selected) === objectIdentity(item);
                return (
                  <button
                    key={objectIdentity(item)}
                    disabled={busy}
                    onClick={() => select(item)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                      active ? "bg-brand/15 text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                    )}
                  >
                    <Icon className={cn("h-3.5 w-3.5 shrink-0", active ? "text-brand" : "text-muted-foreground")} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[12px]" title={objectLabel(item)}>{objectLabel(item)}</span>
                      {item.table && <span className="block truncate text-[10.5px] text-muted-foreground">{item.table}</span>}
                    </span>
                  </button>
                );
              })}
              {objects.length === 0 && (
                <p className="px-2 py-8 text-center text-[12px] text-muted-foreground">
                  {kinds.length === 0 ? t("objects.unsupported_kinds") : t("objects.none")}
                </p>
              )}
            </div>
            <div className="border-t border-border/60 p-2">
              <Button className="w-full" size="sm" disabled={readOnly || busy || kinds.length === 0} onClick={startNew}>
                <Plus className="h-3.5 w-3.5" />
                {t("objects.new", { kind: t(`objects.kind.${kind}`) })}
              </Button>
            </div>
          </aside>

          <section className="flex min-h-0 flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3 text-[12px]">
              {selected ? (
                <>
                  <span className="rounded bg-surface-muted px-1.5 py-0.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                    {t(`objects.kind.${kind}`)}
                  </span>
                  <span className="truncate font-mono font-medium">{objectLabel(selected)}</span>
                  {selected.table && <span className="truncate text-muted-foreground">· {selected.table}</span>}
                </>
              ) : (
                <span className="text-muted-foreground">
                  {definition ? t("objects.new_definition") : t("objects.pick_hint")}
                </span>
              )}
              <div className="flex-1" />
              {selected && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger hover:bg-danger/10 hover:text-danger"
                  disabled={readOnly || busy || !selected.drop_sql}
                  onClick={() => setPendingDrop(selected)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("common.delete")}
                </Button>
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={readOnly || busy || !definition.trim()}
                onClick={applyDefinition}
              >
                {selected ? t("objects.replace") : t("objects.create")}
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              {definition || selected ? (
                <CodeMirrorEditor value={definition} onChange={setDefinition} onRun={() => applyDefinition()} />
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[12px] text-muted-foreground">
                  <FileCode2 className="h-6 w-6 opacity-60" />
                  <p className="max-w-sm">{t("objects.definition_hint")}</p>
                </div>
              )}
            </div>
          </section>
        </div>
      ) : section === "event" ? (
        <MySqlEventManager connectionId={connectionId} schema={schema ?? undefined} readOnly={readOnly} initialName={props.initialName} />
      ) : section === "sequence" ? (
        <SequenceManager connectionId={connectionId} schema={schema ?? undefined} readOnly={readOnly} initialName={props.initialName} />
      ) : (
        <UsersPanel
          connectionId={connectionId}
          schema={schema}
          driver={driver}
          readOnly={readOnly}
          users={catalog.users}
          busy={busy}
          run={run}
          onDrop={setPendingUser}
        />
      )}

      <ConfirmDialog
        open={replaceConfirm}
        onClose={() => setReplaceConfirm(false)}
        onConfirm={() => {
          if (selected?.definition && selected.drop_sql)
            void run("replace_managed_object_definition", {
              id: connectionId,
              original: selected.definition,
              dropSql: selected.drop_sql,
              definition,
            });
        }}
        title={t("objects.replace_title")}
        message={driver === "mysql" ? t("objects.replace_mysql") : t("objects.replace_tx")}
        confirmLabel={t("objects.replace")}
        cancelLabel={t("common.cancel")}
        danger
      />
      <ConfirmDialog
        open={!!pendingDrop}
        title={t("common.delete")}
        message={t("objects.drop_confirm", { name: pendingDrop?.name ?? "" })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => {
          if (pendingDrop?.drop_sql) {
            void run("drop_managed_object", { id: connectionId, definition: pendingDrop.drop_sql }).then((ok) => {
              if (ok) {
                setSelected(null);
                setDefinition("");
              }
            });
          }
          setPendingDrop(null);
        }}
        onClose={() => setPendingDrop(null)}
      />
      <ConfirmDialog
        open={!!pendingUser}
        title={t("objects.drop_user")}
        message={t("objects.drop_confirm", {
          name: `${pendingUser?.name ?? ""}${pendingUser?.host ? `@${pendingUser.host}` : ""}`,
        })}
        confirmLabel={t("common.delete")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => {
          if (pendingUser)
            void run("apply_managed_user", {
              id: connectionId,
              name: pendingUser.name,
              host: pendingUser.host,
              password: null,
              drop: true,
            });
          setPendingUser(null);
        }}
        onClose={() => setPendingUser(null)}
      />
    </div>
  );
}

function SegButton({
  active,
  className,
  children,
  ...props
}: { active: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        "flex h-7 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] transition-colors disabled:pointer-events-none disabled:opacity-40",
        active ? "bg-surface-elevated text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground",
        className
      )}
    >
      {children}
    </button>
  );
}

function UsersPanel({
  connectionId,
  schema,
  driver,
  readOnly,
  users,
  busy,
  run,
  onDrop,
}: {
  connectionId: string;
  schema?: string | null;
  driver: DriverKind;
  readOnly?: boolean;
  users: ManagedUser[];
  busy: boolean;
  run: (command: string, args: Record<string, unknown>) => Promise<boolean>;
  onDrop: (user: ManagedUser) => void;
}) {
  const t = useT();
  const savedDatabase = useConnections((s) => s.list.find((c) => c.id === connectionId)?.database);
  const [name, setName] = useState("");
  const [host, setHost] = useState("%");
  const [password, setPassword] = useState("");
  const [grantee, setGrantee] = useState("");
  const [scope, setScope] = useState<Scope>("table");
  const [database, setDatabase] = useState(schema ?? (driver === "postgres" ? "public" : savedDatabase ?? ""));
  const [object, setObject] = useState("");
  const [privileges, setPrivileges] = useState<string[]>(["SELECT"]);
  const [databases, setDatabases] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);

  useEffect(() => {
    api
      .listDatabases(connectionId)
      .then((list) => setDatabases(Array.isArray(list) ? list : []))
      .catch(() => setDatabases([]));
  }, [connectionId]);
  useEffect(() => {
    if (scope !== "table" || !database) {
      setTables([]);
      return;
    }
    api
      .listTables(connectionId, database)
      .then((list) =>
        setTables((list ?? []).filter((e) => e.kind === "table" || e.kind === "view").map((e) => e.name))
      )
      .catch(() => setTables([]));
  }, [connectionId, database, scope]);

  const privilegeOptions =
    driver === "mysql"
      ? MYSQL_PRIVILEGES.filter((p) => scope !== "table" || p !== "EXECUTE")
      : scope === "schema"
        ? PG_SCHEMA_PRIVILEGES
        : scope === "database"
          ? PG_DATABASE_PRIVILEGES
          : PG_TABLE_PRIVILEGES;

  const changeScope = (next: Scope) => {
    setScope(next);
    setPrivileges([next === "database" && driver === "postgres" ? "CONNECT" : next === "schema" ? "USAGE" : "SELECT"]);
    setDatabase(
      next === "database"
        ? savedDatabase || (driver === "postgres" ? "postgres" : "")
        : schema || (driver === "postgres" ? "public" : savedDatabase ?? "")
    );
    setObject("");
  };
  const grantReady =
    !readOnly && !busy && !!grantee && !!database && privileges.length > 0 && (scope !== "table" || !!object.trim());
  const applyGrants = (grant: boolean) => {
    const [granteeName, granteeHost = ""] = grantee.split("\u0000");
    void run("apply_managed_grants", {
      id: connectionId,
      grantee: granteeName,
      host: driver === "mysql" ? granteeHost : null,
      database,
      object: scope === "table" ? object.trim() || null : null,
      privileges,
      grant,
      scope,
    });
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[300px_1fr]">
      <aside className="min-h-0 overflow-auto border-r border-border/70 bg-surface/20 p-2">
        {users.map((user) => (
          <div
            key={`${user.name}@${user.host ?? ""}`}
            className="group mb-1 rounded-md border border-transparent px-2 py-1.5 hover:border-border/60 hover:bg-accent/40"
          >
            <div className="flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                {user.name}
                {user.host && <span className="text-muted-foreground">@{user.host}</span>}
              </span>
              <button
                disabled={readOnly || busy}
                onClick={() => onDrop(user)}
                title={t("objects.drop_user")}
                aria-label={t("objects.drop_user")}
                className="grid h-6 w-6 place-items-center rounded text-danger opacity-0 hover:bg-danger/10 group-hover:opacity-100 disabled:opacity-0"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {user.grants.length > 0 && (
              <div className="mt-1 line-clamp-3 pl-5 text-[10.5px] leading-relaxed text-muted-foreground">
                {user.grants.join(" · ")}
              </div>
            )}
          </div>
        ))}
        {users.length === 0 && <p className="py-8 text-center text-[12px] text-muted-foreground">{t("objects.no_users")}</p>}
      </aside>
      <div className="min-h-0 space-y-4 overflow-auto p-4">
        <section className="rounded-xl border border-border/70 bg-surface/50 p-4 shadow-soft">
          <h3 className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold">
            <UserPlus className="h-4 w-4 text-brand" />
            {t("objects.create_user")}
          </h3>
          <div className="grid gap-3 md:grid-cols-3">
            <ToolField label={t("objects.user")}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </ToolField>
            {driver === "mysql" && (
              <ToolField label={t("objects.host")}>
                <Input value={host} onChange={(e) => setHost(e.target.value)} />
              </ToolField>
            )}
            <ToolField label={t("objects.password")}>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </ToolField>
          </div>
          <Button
            className="mt-3"
            variant="primary"
            disabled={readOnly || busy || !name.trim() || !password}
            onClick={() =>
              void run("apply_managed_user", {
                id: connectionId,
                name,
                host: driver === "mysql" ? host : null,
                password,
                drop: false,
              }).then((ok) => {
                if (ok) {
                  setName("");
                  setPassword("");
                }
              })
            }
          >
            <UserPlus className="h-3.5 w-3.5" />
            {t("objects.create_user")}
          </Button>
        </section>

        <section className="rounded-xl border border-border/70 bg-surface/50 p-4 shadow-soft">
          <h3 className="mb-3 flex items-center gap-2 text-[12.5px] font-semibold">
            <ShieldCheck className="h-4 w-4 text-brand" />
            {t("objects.privileges")}
          </h3>
          <div className="grid gap-3 md:grid-cols-2">
            <ToolField label={t("objects.user")}>
              <ToolSelect value={grantee} onChange={(e) => setGrantee(e.target.value)} aria-label={t("objects.choose_user")}>
                <option value="">{t("objects.choose_user")}</option>
                {users.map((u) => (
                  <option key={`${u.name}@${u.host ?? ""}`} value={`${u.name}\u0000${u.host ?? ""}`}>
                    {u.name}
                    {u.host ? `@${u.host}` : ""}
                  </option>
                ))}
              </ToolSelect>
            </ToolField>
            <ToolField label={t("objects.scope")}>
              <div className="flex h-9 items-center gap-0.5 rounded-lg border border-border/60 bg-background/40 p-0.5">
                {(["table", "database", ...(driver === "postgres" ? (["schema"] as const) : [])] as Scope[]).map((s) => (
                  <SegButton key={s} active={scope === s} onClick={() => changeScope(s)} className="flex-1 justify-center">
                    {t(`objects.scope.${s}`)}
                  </SegButton>
                ))}
              </div>
            </ToolField>
            <ToolField label={scope === "schema" ? "Schema" : t("objects.database")}>
              <ToolSelect value={database} onChange={(e) => { setDatabase(e.target.value); setObject(""); }}>
                {!databases.includes(database) && database && <option value={database}>{database}</option>}
                {!database && <option value="">—</option>}
                {databases.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </ToolSelect>
            </ToolField>
            {scope === "table" && (
              <ToolField label={t("objects.table")}>
                <ToolSelect value={object} onChange={(e) => setObject(e.target.value)}>
                  <option value="">—</option>
                  {tables.map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </ToolSelect>
              </ToolField>
            )}
          </div>
          <div className="mt-3">
            <div className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">{t("objects.privileges")}</div>
            <div className="flex flex-wrap gap-1.5">
              {privilegeOptions.map((priv) => {
                const on = privileges.includes(priv);
                return (
                  <button
                    key={priv}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setPrivileges(on ? privileges.filter((p) => p !== priv) : [...privileges, priv])}
                    className={cn(
                      "h-7 rounded-full border px-2.5 font-mono text-[11px] transition-colors",
                      on ? "border-brand/60 bg-brand/15 text-brand" : "border-border/70 text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {priv}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            <Button variant="primary" disabled={!grantReady} onClick={() => applyGrants(true)}>
              {t("objects.grant")}
            </Button>
            <Button disabled={!grantReady} onClick={() => applyGrants(false)}>
              {t("objects.revoke")}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
