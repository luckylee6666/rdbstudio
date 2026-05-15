import { useEffect, useState } from "react";
import {
  Activity,
  Binary,
  Braces,
  ChevronRight,
  Clipboard,
  Database,
  FileDown,
  FileUp,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  FunctionSquare,
  Hash,
  Key,
  List,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  ScrollText,
  Settings2,
  Star,
  StarOff,
  Table2,
  Terminal,
  Trash2,
  Type,
  View,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { ConnectionConfig, TreeEntry } from "@/types";
import { ContextMenu, type MenuEntry } from "@/components/ui/ContextMenu";
import { api } from "@/lib/api";
import { ExportDialog } from "@/components/io/ExportDialog";
import { ImportDialog } from "@/components/io/ImportDialog";
import { useT } from "@/store/i18n";
import { cn } from "@/lib/cn";
import { DriverBadge } from "./driverIcon";
import { ConnectionDialog } from "./ConnectionDialog";
import { PromptDialog } from "@/components/ui/PromptDialog";
import { useConnections, type ConnStatus } from "@/store/connections";
import { useWorkspace } from "@/store/workspace";
import { copyText } from "@/lib/clipboard";

function iconFor(kind: string, expanded: boolean): LucideIcon {
  switch (kind) {
    case "folder":
      return expanded ? FolderOpen : FolderClosed;
    case "database":
      return Database;
    case "table":
      return Table2;
    case "view":
      return View;
    case "function":
    case "procedure":
      return FunctionSquare;
    // Redis types — TYPE command returns these as the entry kind
    case "string":
      return Type;
    case "hash":
      return Hash;
    case "list":
      return List;
    case "set":
    case "zset":
      return Braces;
    case "stream":
      return Activity;
    case "ReJSON-RL":
      return Binary;
    default:
      return Key;
  }
}

function isRedisKeyKind(kind: string): boolean {
  return kind !== "table" && kind !== "view";
}

// Format a PTTL value for tree display: -1 → "∞" (no expiry), else a coarse
// human duration so the tree doesn't get noisy with ms-level precision.
function formatTtl(ms?: number | null): string {
  if (ms == null) return "—";
  if (ms === -1) return "∞";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function ConnectionTree() {
  const { list, loaded, refresh, remove } = useConnections();
  const [dlgOpen, setDlgOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | null>(null);
  const [emptyGroups, setEmptyGroupsState] = useState<string[]>(() =>
    loadEmptyGroups()
  );
  const [promptOpen, setPromptOpen] = useState(false);
  const t = useT();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const newConn = () => {
    setEditing(null);
    setDlgOpen(true);
  };

  const updateEmptyGroups = (next: string[]) => {
    // Dedup + sort for stable storage.
    const dedup = Array.from(new Set(next)).sort((a, b) => a.localeCompare(b));
    setEmptyGroupsState(dedup);
    saveEmptyGroups(dedup);
  };

  const newGroup = () => setPromptOpen(true);

  const onNewGroupSubmit = (raw: string) => {
    const name = raw.trim();
    if (!name) return;
    // No-op if a connection already lives in this group, but still surface the
    // folder by adding to emptyGroups (de-dup'd downstream against buckets).
    updateEmptyGroups([...emptyGroups, name]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("sidebar.connections")}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => refresh()}
            title={t("common.refresh")}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={newGroup}
            title={t("conn.new_group")}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={newConn}
            title={t("sidebar.new_connection")}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-2 pb-3">
        {!loaded ? (
          <Skeleton />
        ) : list.length === 0 ? (
          <EmptyState onNew={newConn} />
        ) : (
          <GroupedConnections
            list={list}
            emptyGroups={emptyGroups}
            setEmptyGroups={updateEmptyGroups}
            onEdit={(c) => {
              setEditing(c);
              setDlgOpen(true);
            }}
            onDelete={(c) => void remove(c.id)}
          />
        )}
      </div>

      <ConnectionDialog
        open={dlgOpen}
        initial={editing}
        onClose={() => setDlgOpen(false)}
      />

      <PromptDialog
        open={promptOpen}
        title={t("conn.new_group")}
        label={t("conn.new_group.prompt")}
        placeholder="Prod / Staging / …"
        submitLabel={t("common.save")}
        cancelLabel={t("common.cancel")}
        onSubmit={onNewGroupSubmit}
        onClose={() => setPromptOpen(false)}
      />
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 px-1 py-1">
      {Array.from({ length: 3 }).map((_, i) => (
        <div
          key={i}
          className="h-10 animate-pulse rounded-md bg-surface-muted/60"
        />
      ))}
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const t = useT();
  return (
    <div className="mt-6 rounded-lg border border-dashed border-border/80 bg-surface-muted/30 p-5 text-center">
      <div className="mb-2 inline-grid h-9 w-9 place-items-center rounded-md bg-accent text-foreground">
        <Plug className="h-4 w-4" />
      </div>
      <div className="text-[13px] font-medium">{t("sidebar.connections.empty.title")}</div>
      <div className="mt-0.5 text-[11.5px] text-muted-foreground">
        {t("sidebar.connections.empty.desc")}
      </div>
      <button
        onClick={onNew}
        className="mt-3 inline-flex h-7 items-center gap-1.5 rounded-md bg-brand px-2.5 text-[12px] font-medium text-brand-foreground hover:bg-brand/90"
      >
        <Plus className="h-3.5 w-3.5" />
        {t("sidebar.new_connection")}
      </button>
    </div>
  );
}

function statusDot(s?: ConnStatus) {
  if (s === "connected")
    return "bg-success shadow-[0_0_6px_hsl(var(--success))]";
  if (s === "connecting") return "bg-warning animate-pulse";
  if (s === "error") return "bg-danger";
  return "bg-muted-foreground/40";
}

function sortWithinGroup(list: ConnectionConfig[]): ConnectionConfig[] {
  return list.slice().sort((a, b) => {
    const pa = a.pinned ? 0 : 1;
    const pb = b.pinned ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

const GROUP_OPEN_KEY = "rdb:connGroupOpen";
const EMPTY_GROUPS_KEY = "rdb:connEmptyGroups";

// We implement drag-and-drop manually with mouse events instead of HTML5 DnD.
// Tauri's WKWebView tends to swallow dragstart when the draggable element
// contains a <button>, so HTML5 drag is unreliable here. Drop zones are
// marked with data-conn-drop="<group-name>" (empty string = ungrouped) and
// looked up via elementFromPoint during the move.
const CONN_DROP_ATTR = "data-conn-drop";
const DRAG_THRESHOLD_PX = 5;

type ConnDragState = {
  connId: string;
  hoverGroup: string | null; // null when not over a drop zone
} | null;

const dragListeners = new Set<() => void>();
let connDragState: ConnDragState = null;

function getConnDrag(): ConnDragState {
  return connDragState;
}

function setConnDrag(next: ConnDragState) {
  connDragState = next;
  dragListeners.forEach((fn) => fn());
}

function useConnDrag(): ConnDragState {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    dragListeners.add(fn);
    return () => {
      dragListeners.delete(fn);
    };
  }, []);
  return connDragState;
}

function dropTargetAt(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const zone = (el as Element).closest(`[${CONN_DROP_ATTR}]`);
  if (!zone) return null;
  return zone.getAttribute(CONN_DROP_ATTR);
}

function loadGroupOpenState(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(GROUP_OPEN_KEY);
    if (!raw) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function saveGroupOpenState(s: Record<string, boolean>) {
  try {
    localStorage.setItem(GROUP_OPEN_KEY, JSON.stringify(s));
  } catch {
    /* quota/private-mode — fall back to in-memory only */
  }
}

function loadEmptyGroups(): string[] {
  try {
    const raw = localStorage.getItem(EMPTY_GROUPS_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveEmptyGroups(arr: string[]) {
  try {
    localStorage.setItem(EMPTY_GROUPS_KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
}

function GroupedConnections({
  list,
  emptyGroups,
  setEmptyGroups,
  onEdit,
  onDelete,
}: {
  list: ConnectionConfig[];
  emptyGroups: string[];
  setEmptyGroups: (g: string[]) => void;
  onEdit: (c: ConnectionConfig) => void;
  onDelete: (c: ConnectionConfig) => void;
}) {
  // Bucket by group. Empty/whitespace group => ungrouped.
  const ungrouped: ConnectionConfig[] = [];
  const buckets = new Map<string, ConnectionConfig[]>();
  for (const c of list) {
    const g = (c.group ?? "").trim();
    if (!g) ungrouped.push(c);
    else {
      const arr = buckets.get(g) ?? [];
      arr.push(c);
      buckets.set(g, arr);
    }
  }
  // Union of groups with members and persisted empty groups.
  const allGroups = new Set<string>([
    ...buckets.keys(),
    ...emptyGroups,
  ]);
  const groupNames = Array.from(allGroups).sort((a, b) =>
    a.localeCompare(b)
  );

  const deleteEmptyGroup = (name: string) => {
    setEmptyGroups(emptyGroups.filter((g) => g !== name));
  };

  return (
    <>
      <UngroupedDropZone>
        {sortWithinGroup(ungrouped).map((c) => (
          <ConnectionBranch
            key={c.id}
            cfg={c}
            onEdit={() => onEdit(c)}
            onDelete={() => onDelete(c)}
          />
        ))}
      </UngroupedDropZone>
      {groupNames.map((g) => {
        const conns = sortWithinGroup(buckets.get(g) ?? []);
        return (
          <GroupFolder
            key={g}
            name={g}
            connections={conns}
            isEmpty={conns.length === 0}
            onDeleteEmpty={() => deleteEmptyGroup(g)}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        );
      })}
    </>
  );
}

function UngroupedDropZone({ children }: { children: React.ReactNode }) {
  const drag = useConnDrag();
  const over = drag != null && drag.hoverGroup === "";
  return (
    <div
      {...{ [CONN_DROP_ATTR]: "" }}
      className={cn(
        "min-h-[24px] rounded-md transition-colors",
        over && "ring-1 ring-brand/60 bg-brand/5"
      )}
    >
      {children}
    </div>
  );
}

function GroupFolder({
  name,
  connections,
  isEmpty,
  onDeleteEmpty,
  onEdit,
  onDelete,
}: {
  name: string;
  connections: ConnectionConfig[];
  isEmpty: boolean;
  onDeleteEmpty: () => void;
  onEdit: (c: ConnectionConfig) => void;
  onDelete: (c: ConnectionConfig) => void;
}) {
  const drag = useConnDrag();
  const over = drag != null && drag.hoverGroup === name;
  const [open, setOpen] = useState<boolean>(() => {
    const saved = loadGroupOpenState()[name];
    // Default to open on first sight so newly-grouped connections aren't hidden.
    return saved !== false;
  });
  const t = useT();
  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      const all = loadGroupOpenState();
      all[name] = next;
      saveGroupOpenState(all);
      return next;
    });
  };

  // Auto-expand the folder while a connection is being dragged onto it so the
  // user gets immediate visual feedback that the drop will land inside.
  useEffect(() => {
    if (over && !open) setOpen(true);
  }, [over, open]);

  const handleDeleteClick = (e: React.MouseEvent) => {
    // Empty-group deletion is fully reversible (just create it again), so we
    // skip a confirmation step that would be blocked by Tauri's webview anyway.
    e.stopPropagation();
    onDeleteEmpty();
  };

  return (
    <div
      {...{ [CONN_DROP_ATTR]: name }}
      className={cn(
        "group/group mb-1 rounded-md transition-colors",
        over && "ring-1 ring-brand/60 bg-brand/5"
      )}
    >
      <div className="flex items-center gap-0.5 rounded-md hover:bg-accent/40">
        <button
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform",
              open && "rotate-90"
            )}
          />
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 text-brand/80" />
          ) : (
            <FolderClosed className="h-3.5 w-3.5 text-brand/80" />
          )}
          <span className="truncate">{name}</span>
          <span className="ml-1 text-[10.5px] font-normal text-muted-foreground/70">
            {connections.length}
          </span>
        </button>
        {isEmpty && (
          <button
            onClick={handleDeleteClick}
            title={t("conn.delete_group")}
            className="mr-1 grid h-5 w-5 place-items-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-danger group-hover/group:opacity-100"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>
      {open && (
        <div className="ml-2 border-l border-border/40 pl-1">
          {connections.map((c) => (
            <ConnectionBranch
              key={c.id}
              cfg={c}
              onEdit={() => onEdit(c)}
              onDelete={() => onDelete(c)}
            />
          ))}
          {isEmpty && (
            <div className="px-2 py-1.5 text-[11px] italic text-muted-foreground/70">
              (drop a connection here)
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ConnectionBranch({
  cfg,
  onEdit,
  onDelete,
}: {
  cfg: ConnectionConfig;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const status = useConnections((s) => s.status[cfg.id] ?? "disconnected");
  const branch = useConnections((s) => s.branches[cfg.id]);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const save = useConnections((s) => s.save);
  const refreshBranch = useConnections((s) => s.refreshBranch);
  const allConnections = useConnections((s) => s.list);
  const [open, setOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [movePromptOpen, setMovePromptOpen] = useState(false);
  const t = useT();

  // Suggest existing groups so the prompt doubles as a picker without us
  // having to build a full select-or-create combobox.
  const groupSuggestions = (() => {
    const seen = new Set<string>();
    for (const c of allConnections) {
      const g = (c.group ?? "").trim();
      if (g) seen.add(g);
    }
    return Array.from(seen).sort((a, b) => a.localeCompare(b));
  })();

  const togglePin = () => {
    void save({ ...cfg, pinned: !cfg.pinned });
  };

  const onMoveSubmit = (raw: string) => {
    const trimmed = raw.trim();
    void save({ ...cfg, group: trimmed || null });
  };

  const removeFromGroup = () => {
    void save({ ...cfg, group: null });
  };

  const toggle = async () => {
    if (status !== "connected") {
      try {
        await connect(cfg.id);
        setOpen(true);
      } catch {
        /* error surfaced in store */
      }
      return;
    }
    setOpen((o) => !o);
  };

  const onDisconnect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await disconnect(cfg.id);
    setOpen(false);
  };

  return (
    <div
      className="group mb-1"
      onMouseDown={(e) => {
        // Manual drag: only left button, only when click starts on the row
        // (not on the chevron/buttons inside — those need their own clicks).
        if (e.button !== 0) return;
        const startX = e.clientX;
        const startY = e.clientY;
        const onMove = (ev: MouseEvent) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (
            getConnDrag() == null &&
            Math.hypot(dx, dy) < DRAG_THRESHOLD_PX
          ) {
            return; // not a drag yet
          }
          if (getConnDrag() == null) {
            setConnDrag({ connId: cfg.id, hoverGroup: null });
          }
          const hover = dropTargetAt(ev.clientX, ev.clientY);
          const cur = getConnDrag();
          if (cur && cur.hoverGroup !== hover) {
            setConnDrag({ ...cur, hoverGroup: hover });
          }
        };
        const onUp = (ev: MouseEvent) => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
          const cur = getConnDrag();
          setConnDrag(null);
          if (!cur) return; // never crossed threshold — treat as click
          // Suppress the click event that follows this mouseup so the button
          // inside the row doesn't fire its toggle handler after a drag.
          const swallow = (ce: Event) => {
            ce.stopPropagation();
            ce.preventDefault();
            window.removeEventListener("click", swallow, true);
          };
          window.addEventListener("click", swallow, { capture: true, once: true });
          const target = dropTargetAt(ev.clientX, ev.clientY);
          if (target == null) return;
          const groupName = target === "" ? null : target;
          const currentGroup = (cfg.group ?? "").trim() || null;
          if (currentGroup === groupName) return;
          void save({ ...cfg, group: groupName });
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }}
      style={{ cursor: "grab" }}
    >
      <div className="flex items-center gap-1 rounded-md hover:bg-accent/50">
        <button
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1.5 text-left"
        >
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
              open && status === "connected" && "rotate-90"
            )}
          />
          <DriverBadge driver={cfg.driver} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 truncate text-[13px] font-medium">
              <span className="truncate">{cfg.name}</span>
              {cfg.pinned && (
                <Star className="h-3 w-3 shrink-0 fill-warning text-warning" />
              )}
            </div>
            <div className="truncate text-[11px] text-muted-foreground">
              {cfg.driver === "sqlite"
                ? cfg.file_path ?? "—"
                : cfg.driver === "redis"
                ? `${cfg.host ?? "?"}:${cfg.port ?? "?"} · db${cfg.database ?? "0"}`
                : `${cfg.host ?? "?"}${cfg.database ? " · " + cfg.database : ""}`}
            </div>
          </div>
          {status === "connecting" ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-warning" />
          ) : (
            <span
              className={cn(
                "h-1.5 w-1.5 shrink-0 rounded-full",
                statusDot(status)
              )}
            />
          )}
        </button>
        <div className="relative pr-1 opacity-0 group-hover:opacity-100">
          {status === "connected" && (
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void refreshBranch(cfg.id);
                }}
                title={t("common.refresh")}
                className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={onDisconnect}
                title={t("conn.disconnect")}
                className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <PlugZap className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            className="grid h-6 w-6 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
          {menuOpen && (
            <div
              onMouseLeave={() => setMenuOpen(false)}
              className="absolute right-1 top-7 z-20 w-40 overflow-hidden rounded-md border border-border/80 bg-surface-elevated py-1 text-[12.5px] shadow-elevated"
            >
              <MenuItem
                icon={cfg.pinned ? StarOff : Star}
                onClick={() => { setMenuOpen(false); togglePin(); }}
              >
                {cfg.pinned ? t("conn.unpin") : t("conn.pin")}
              </MenuItem>
              <MenuItem
                icon={FolderOpen}
                onClick={() => { setMenuOpen(false); setMovePromptOpen(true); }}
              >
                {t("conn.move_to_group")}
              </MenuItem>
              {cfg.group && (
                <MenuItem
                  icon={FolderClosed}
                  onClick={() => { setMenuOpen(false); removeFromGroup(); }}
                >
                  {t("conn.remove_from_group")}
                </MenuItem>
              )}
              <MenuItem icon={Pencil} onClick={() => { setMenuOpen(false); onEdit(); }}>
                {t("conn.edit")}
              </MenuItem>
              <MenuItem
                icon={Trash2}
                onClick={() => { setMenuOpen(false); onDelete(); }}
                danger
              >
                {t("conn.delete")}
              </MenuItem>
            </div>
          )}
        </div>
      </div>

      {open && status === "connected" && (
        <div className="ml-5 mt-0.5 border-l border-border/60 pl-1">
          {!branch || branch.loading ? (
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              loading…
            </div>
          ) : branch.error ? (
            <div className="px-2 py-1 text-[11px] text-danger">{branch.error}</div>
          ) : (
            <DatabaseList connectionId={cfg.id} databases={branch.databases ?? []} />
          )}
        </div>
      )}

      <PromptDialog
        open={movePromptOpen}
        title={t("conn.move_to_group")}
        label={t("conn.move_to_group.prompt")}
        initialValue={cfg.group ?? ""}
        placeholder="Prod / Staging / …"
        submitLabel={t("common.save")}
        cancelLabel={t("common.cancel")}
        suggestions={groupSuggestions}
        onSubmit={onMoveSubmit}
        onClose={() => setMovePromptOpen(false)}
      />
    </div>
  );
}

function MenuItem({
  icon: Icon,
  children,
  onClick,
  danger,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent",
        danger ? "text-danger" : "text-foreground"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function DatabaseList({
  connectionId,
  databases,
}: {
  connectionId: string;
  databases: string[];
}) {
  return (
    <>
      {databases.map((db) => (
        <DatabaseNode key={db} connectionId={connectionId} database={db} />
      ))}
    </>
  );
}

function DatabaseNode({
  connectionId,
  database,
}: {
  connectionId: string;
  database: string;
}) {
  const [open, setOpen] = useState(
    database === "main" ||
      database === "public" ||
      /^db\d+$/.test(database)
  );
  const branch = useConnections((s) => s.branches[connectionId]);
  const loadTables = useConnections((s) => s.loadTables);
  const openTab = useWorkspace((s) => s.openTab);
  // Treat the database label as the schema key. SQLite reports "main" but
  // its meta queries don't take a schema — pass undefined to the backend
  // while still caching/looking up under the same display key.
  const schemaKey = database;
  const passSchema = schemaKey === "main" ? undefined : schemaKey;
  const tables = branch?.tables?.[schemaKey];
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);
  const t = useT();

  const openEr = () =>
    openTab({
      id: `er:${connectionId}:${schemaKey}`,
      kind: "er",
      title: `${database} · ER`,
      subtitle: "Diagram",
      connectionId,
      schema: passSchema,
    });

  useEffect(() => {
    if (open && !tables) {
      void loadTables(connectionId, schemaKey, passSchema);
    }
  }, [open, tables, loadTables, connectionId, schemaKey, passSchema]);

  const Icon = Database;

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        onContextMenu={(e) => {
          e.preventDefault();
          setCtx({ x: e.clientX, y: e.clientY });
        }}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-foreground/85 hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <Icon className="h-3.5 w-3.5 text-brand/90" />
        <span className="truncate">{database}</span>
      </button>
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={[
            {
              id: "er",
              label: t("tree.open_er"),
              icon: Workflow,
              onClick: openEr,
            },
            {
              id: "query",
              label: t("tree.new_query"),
              icon: Terminal,
              onClick: () =>
                openTab({
                  id: `query:${crypto.randomUUID()}`,
                  kind: "query",
                  title: "Query",
                  subtitle: database,
                  connectionId,
                }),
            },
          ]}
          onClose={() => setCtx(null)}
        />
      )}
      {open && (
        <div className="ml-4 border-l border-border/60 pl-1">
          {!tables ? (
            <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              loading…
            </div>
          ) : tables.length === 0 ? (
            <div className="px-2 py-1 text-[11px] text-muted-foreground">
              (no tables)
            </div>
          ) : (
            <TableGroup
              connectionId={connectionId}
              schema={passSchema}
              entries={tables}
              cacheKey={schemaKey}
            />
          )}
        </div>
      )}
    </div>
  );
}

function TableGroup({
  connectionId,
  schema,
  entries,
  cacheKey,
}: {
  connectionId: string;
  schema?: string;
  entries: TreeEntry[];
  cacheKey: string;
}) {
  const tables = entries.filter((e) => e.kind === "table");
  const views = entries.filter((e) => e.kind === "view");
  // Redis: list_keys returns entries whose kind is the value type (string/hash/list/...).
  // Surface them in a dedicated "Keys" folder so they don't get silently dropped.
  const keys = entries.filter((e) => isRedisKeyKind(e.kind));
  return (
    <div className="space-y-0.5">
      {keys.length > 0 && (
        <Folder
          label="Keys"
          count={keys.length}
          entries={keys}
          connectionId={connectionId}
          schema={schema}
          cacheKey={cacheKey}
          defaultOpen
        />
      )}
      {tables.length > 0 && (
        <Folder
          label="Tables"
          count={tables.length}
          entries={tables}
          connectionId={connectionId}
          schema={schema}
          cacheKey={cacheKey}
        />
      )}
      {views.length > 0 && (
        <Folder
          label="Views"
          count={views.length}
          entries={views}
          connectionId={connectionId}
          schema={schema}
          cacheKey={cacheKey}
        />
      )}
    </div>
  );
}

function Folder({
  label,
  count,
  entries,
  connectionId,
  schema,
  cacheKey,
  defaultOpen = true,
}: {
  label: string;
  count: number;
  entries: TreeEntry[];
  connectionId: string;
  schema?: string;
  cacheKey: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: TreeEntry } | null>(null);
  const [exportTarget, setExportTarget] = useState<TreeEntry | null>(null);
  const [importTarget, setImportTarget] = useState<TreeEntry | null>(null);
  const openTab = useWorkspace((s) => s.openTab);
  const branch = useConnections((s) => s.branches[connectionId]);
  const loadMoreRedisKeys = useConnections((s) => s.loadMoreRedisKeys);
  const isKeysFolder = label === "Keys";
  const showLoadMore = isKeysFolder && branch?.redisDone === false;
  const loadingMore = !!branch?.redisLoadingMore;
  const t = useT();

  const openData = (e: TreeEntry) => {
    // Redis key: open a dedicated viewer that renders the value by type
    // (string/hash/list/set/zset/stream/...) rather than a SQL editor.
    if (isRedisKeyKind(e.kind)) {
      openTab({
        id: `redis:${connectionId}:${e.name}`,
        kind: "redis-key",
        title: e.name,
        subtitle: e.kind,
        connectionId,
        redisKey: e.name,
        redisType: e.kind,
      });
      return;
    }
    openTab({
      id: `data:${connectionId}:${schema ?? ""}:${e.name}`,
      kind: "table-data",
      title: e.name,
      subtitle: e.kind === "view" ? "View" : "Data",
      connectionId,
      schema,
      table: e.name,
    });
  };

  const openDesigner = (e: TreeEntry) =>
    openTab({
      id: `design:${connectionId}:${schema ?? ""}:${e.name}`,
      kind: "designer",
      title: e.name,
      subtitle: "Design",
      connectionId,
      schema,
      table: e.name,
    });

  const showDdlTab = async (e: TreeEntry) => {
    try {
      const ddl = await api.showDdl(connectionId, e.name, schema);
      const id = `query:ddl:${connectionId}:${schema ?? ""}:${e.name}`;
      openTab({
        id,
        kind: "query",
        title: `${e.name} · DDL`,
        subtitle: "DDL",
        connectionId,
      });
      // Prime the editor buffer via a lightweight sessionStorage channel
      sessionStorage.setItem(`rdb:sql:${id}`, ddl);
    } catch (err) {
      console.error(err);
    }
  };

  const copyName = (name: string) => {
    void copyText(name);
  };

  const buildMenu = (e: TreeEntry): MenuEntry[] => [
    {
      id: "open",
      label: t("tree.open_data"),
      icon: Table2,
      shortcut: "⇧↵",
      onClick: () => openData(e),
    },
    {
      id: "design",
      label: t("tree.design_table"),
      icon: Settings2,
      disabled: e.kind !== "table",
      onClick: () => openDesigner(e),
    },
    {
      id: "ddl",
      label: t("tree.show_ddl"),
      icon: ScrollText,
      onClick: () => void showDdlTab(e),
    },
    { id: "sep1", label: "", separator: true },
    {
      id: "export",
      label: t("tree.export"),
      icon: FileDown,
      onClick: () => setExportTarget(e),
    },
    {
      id: "import",
      label: t("tree.import_csv"),
      icon: FileUp,
      disabled: e.kind !== "table",
      onClick: () => setImportTarget(e),
    },
    { id: "sep2", label: "", separator: true },
    {
      id: "copy",
      label: t("tree.copy_name"),
      icon: Clipboard,
      shortcut: "⌘C",
      onClick: () => copyName(e.name),
    },
  ];

  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-[12.5px] text-muted-foreground hover:bg-accent/50"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform",
            open && "rotate-90"
          )}
        />
        {open ? (
          <FolderOpen className="h-3.5 w-3.5" />
        ) : (
          <FolderClosed className="h-3.5 w-3.5" />
        )}
        <span className="truncate">{label}</span>
        <span className="ml-auto text-[11px] tabular-nums">{count}</span>
      </button>
      {open && (
        <div className="ml-4">
          {entries.map((e) => {
            const Icon = iconFor(e.kind, false);
            return (
              <button
                key={e.name}
                onDoubleClick={() => openData(e)}
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  setCtx({ x: ev.clientX, y: ev.clientY, entry: e });
                }}
                title={isRedisKeyKind(e.kind) ? `${e.name}\n${e.kind} · ${formatTtl(e.ttl_ms)}` : e.name}
                className="group/key flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-foreground/85 hover:bg-accent/50"
              >
                <span className="w-3.5" />
                <Icon
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    e.kind === "table" && "text-sky-400",
                    e.kind === "view" && "text-emerald-400",
                    isRedisKeyKind(e.kind) && "text-rose-300/90"
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {isRedisKeyKind(e.kind) && e.ttl_ms != null && (
                  <span
                    className={cn(
                      "shrink-0 rounded px-1 text-[10px] tabular-nums",
                      e.ttl_ms === -1
                        ? "text-muted-foreground/60"
                        : e.ttl_ms < 60_000
                        ? "bg-warning/20 text-warning"
                        : "text-muted-foreground"
                    )}
                  >
                    {formatTtl(e.ttl_ms)}
                  </span>
                )}
              </button>
            );
          })}
          {showLoadMore && (
            <button
              onClick={() => void loadMoreRedisKeys(connectionId, cacheKey)}
              disabled={loadingMore}
              className="mt-0.5 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-border/70 bg-surface/30 px-2 py-1 text-[11.5px] text-muted-foreground hover:border-border hover:bg-accent/30 hover:text-foreground disabled:opacity-50"
            >
              {loadingMore ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  scanning…
                </>
              ) : (
                <>+ Load more keys</>
              )}
            </button>
          )}
        </div>
      )}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={buildMenu(ctx.entry)}
          onClose={() => setCtx(null)}
        />
      )}
      <ExportDialog
        open={!!exportTarget}
        connectionId={connectionId}
        table={exportTarget?.name ?? ""}
        schema={schema}
        onClose={() => setExportTarget(null)}
      />
      <ImportDialog
        open={!!importTarget}
        connectionId={connectionId}
        table={importTarget?.name ?? ""}
        schema={schema}
        onClose={() => setImportTarget(null)}
      />
    </div>
  );
}
