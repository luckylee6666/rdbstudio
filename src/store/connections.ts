import { create } from "zustand";
import { api } from "@/lib/api";
import { clearSchemaColumns } from "@/lib/schemaCache";
import { toast } from "@/store/toasts";
import { translate, useI18n } from "@/store/i18n";
import type { ConnectionConfig, TreeEntry } from "@/types";

type ConnStatus = "disconnected" | "connecting" | "connected" | "error";

interface Branch {
  loading?: boolean;
  error?: string;
  databases?: string[];
  tables?: Record<string, TreeEntry[]>;
  /** Per-schema table-list load failures, keyed like `tables`. */
  tablesError?: Record<string, string>;
  /** Redis-only: last cursor returned by SCAN; 0 = exhausted. */
  redisCursor?: number;
  redisDone?: boolean;
  redisLoadingMore?: boolean;
}

interface ConnectionsState {
  list: ConnectionConfig[];
  loaded: boolean;
  /** Set when `list_connections` itself fails, so the tree can offer a retry. */
  listError: string | null;
  status: Record<string, ConnStatus>;
  versions: Record<string, string | undefined>;
  branches: Record<string, Branch>;
  errors: Record<string, string | undefined>;
  /** Live filter for table/key names in the sidebar tree. */
  treeFilter: string;
  setTreeFilter: (v: string) => void;

  refresh: () => Promise<void>;
  refreshBranch: (id: string) => Promise<void>;
  save: (cfg: ConnectionConfig) => Promise<ConnectionConfig>;
  remove: (id: string) => Promise<void>;
  connect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
  loadDatabases: (id: string) => Promise<void>;
  /**
   * @param cacheKey display key used in the tree (eg. "main" for SQLite, "public" for PG).
   * @param schema  schema name passed to the backend; pass undefined when the driver
   *                doesn't take one (eg. SQLite's "main") so meta queries stay correct
   *                while the cache still keys on the display label.
   */
  loadTables: (id: string, cacheKey: string, schema?: string) => Promise<void>;
  /** Redis-only: append next batch of keys using the saved cursor. */
  loadMoreRedisKeys: (id: string, cacheKey: string) => Promise<void>;
}

export const useConnections = create<ConnectionsState>((set, get) => {
  // Invalidate refresh snapshots when a user mutates connection state while
  // list/status requests are pending.
  let mutationEpoch = 0;
  const saveGenerations = new Map<string, number>();
  const deletionGenerations = new Map<string, number>();
  const lifecycleGenerations = new Map<string, number>();
  const bumpGeneration = (map: Map<string, number>, id: string) => {
    const generation = (map.get(id) ?? 0) + 1;
    map.set(id, generation);
    return generation;
  };

  return {
  list: [],
  loaded: false,
  listError: null,
  status: {},
  versions: {},
  branches: {},
  errors: {},
  treeFilter: "",
  setTreeFilter: (v) => set({ treeFilter: v }),

  refresh: async () => {
    try {
      const epoch = mutationEpoch;
      const list = await api.listConnections();
      if (epoch !== mutationEpoch) return;
      set({ list, loaded: true, listError: null });
      // Adopt pools the backend still holds (e.g. after a webview reload) so
      // the UI never shows "disconnected" for a live connection.
      const candidates = list.filter((c) => get().status[c.id] === undefined);
      const live = await Promise.all(
        candidates
          .map((c) =>
            api
              .connectionStatus(c.id)
              .then((s) => (s?.connected ? s : null))
              .catch(() => null)
          )
      );
      if (epoch !== mutationEpoch) return;
      const adopted = live.filter((s): s is NonNullable<typeof s> => s !== null);
      if (adopted.length > 0) {
        const status = { ...get().status };
        const versions = { ...get().versions };
        for (const s of adopted) {
          // A user action may have changed status (or removed the connection)
          // while connection_status was in flight. Only adopt untouched rows.
          if (status[s.id] !== undefined || !get().list.some((c) => c.id === s.id)) continue;
          status[s.id] = "connected";
          if (s.server_version) versions[s.id] = s.server_version;
        }
        set({ status, versions });
      }
      // re-fetch trees for currently-connected pools so stale cache clears
      for (const c of list) {
        if (
          get().list.some((current) => current.id === c.id) &&
          get().status[c.id] === "connected"
        ) {
          await get().refreshBranch(c.id);
        }
      }
    } catch (e: unknown) {
      // Keep the tree out of its skeleton state; ConnectionTree surfaces the
      // error with a retry button instead of spinning forever.
      set({ loaded: true, listError: String(e) });
    }
  },

  refreshBranch: async (id) => {
    clearSchemaColumns(id);
    const branches = { ...get().branches };
    delete branches[id];
    set({ branches });
    if (get().status[id] === "connected") {
      await get().loadDatabases(id);
    }
  },

  save: async (cfg) => {
    mutationEpoch++;
    const saveGeneration = cfg.id ? bumpGeneration(saveGenerations, cfg.id) : undefined;
    const deletionGeneration = cfg.id ? deletionGenerations.get(cfg.id) ?? 0 : undefined;
    const saveLifecycleGeneration = cfg.id ? bumpGeneration(lifecycleGenerations, cfg.id) : undefined;
    const saved = await api.saveConnection(cfg);
    if (
      cfg.id &&
      (saveGenerations.get(cfg.id) !== saveGeneration ||
        (deletionGenerations.get(cfg.id) ?? 0) !== deletionGeneration)
    ) {
      return saved;
    }
    const list = [...get().list.filter((c) => c.id !== saved.id), saved];
    set({ list });
    const statusGeneration = lifecycleGenerations.get(saved.id) ?? 0;
    if (
      saveLifecycleGeneration !== undefined &&
      saveLifecycleGeneration !== (lifecycleGenerations.get(saved.id) ?? 0)
    ) {
      return saved;
    }
    await api
      .connectionStatus(saved.id)
      .then((status) => {
        if (
          statusGeneration === (lifecycleGenerations.get(saved.id) ?? 0) &&
          get().list.some((c) => c.id === saved.id) &&
          status &&
          !status.connected
        ) {
          const branches = { ...get().branches };
          delete branches[saved.id];
          const versions = { ...get().versions };
          delete versions[saved.id];
          set({
            status: { ...get().status, [saved.id]: "disconnected" },
            branches,
            versions,
          });
        }
      })
      .catch(() => {
        // Saving succeeded; status can be retried independently.
      });
    return saved;
  },

  remove: async (id) => {
    mutationEpoch++;
    bumpGeneration(deletionGenerations, id);
    bumpGeneration(lifecycleGenerations, id);
    await api.deleteConnection(id);
    const { [id]: _s, ...status } = get().status;
    const { [id]: _b, ...branches } = get().branches;
    const { [id]: _v, ...versions } = get().versions;
    const { [id]: _e, ...errors } = get().errors;
    set({
      list: get().list.filter((c) => c.id !== id),
      status,
      branches,
      versions,
      errors,
    });
  },

  connect: async (id) => {
    // One attempt at a time — a second click during a slow (e.g. SSH) connect
    // would race the first and leave status reflecting whichever finished last.
    if (get().status[id] === "connecting") return;
    mutationEpoch++;
    bumpGeneration(lifecycleGenerations, id);
    set({ status: { ...get().status, [id]: "connecting" }, errors: { ...get().errors, [id]: undefined } });
    try {
      const s = await api.connect(id);
      bumpGeneration(lifecycleGenerations, id);
      set({
        status: { ...get().status, [id]: "connected" },
        versions: { ...get().versions, [id]: s.server_version ?? undefined },
      });
      await get().loadDatabases(id);
    } catch (e: unknown) {
      bumpGeneration(lifecycleGenerations, id);
      set({
        status: { ...get().status, [id]: "error" },
        errors: { ...get().errors, [id]: String(e) },
      });
      throw e;
    }
  },

  disconnect: async (id) => {
    mutationEpoch++;
    bumpGeneration(lifecycleGenerations, id);
    await api.disconnect(id);
    clearSchemaColumns(id);
    const branches = { ...get().branches };
    delete branches[id];
    const versions = { ...get().versions };
    delete versions[id];
    set({
      status: { ...get().status, [id]: "disconnected" },
      branches,
      versions,
    });
  },

  loadDatabases: async (id) => {
    set({
      branches: {
        ...get().branches,
        [id]: { ...(get().branches[id] ?? {}), loading: true },
      },
    });
    try {
      const databases = await api.listDatabases(id);
      if (!get().list.some((c) => c.id === id) || get().status[id] !== "connected") return;
      const latest = get().branches[id] ?? {};
      set({
        branches: {
          ...get().branches,
          [id]: { ...latest, databases, loading: false, error: undefined },
        },
      });
    } catch (e: unknown) {
      if (!get().list.some((c) => c.id === id) || get().status[id] !== "connected") return;
      const latest = get().branches[id] ?? {};
      set({
        branches: {
          ...get().branches,
          [id]: { ...latest, error: String(e), loading: false },
        },
      });
    }
  },

  loadTables: async (id, cacheKey, schema) => {
    const driver = get().list.find((c) => c.id === id)?.driver;
    // IMPORTANT: read the branch fresh AFTER each await. Two schemas expanded
    // concurrently both resolve against this store — a pre-await snapshot
    // would make the slower one overwrite the faster one's just-loaded tables.
    const merge = (patch: (latest: Branch) => Branch) => {
      const latest = get().branches[id] ?? {};
      set({ branches: { ...get().branches, [id]: patch(latest) } });
    };
    const withoutError = (latest: Branch) => {
      const { [cacheKey]: _gone, ...rest } = latest.tablesError ?? {};
      return rest;
    };
    try {
      // Redis: use the paginated scan path so we can drive "Load more" later.
      if (driver === "redis") {
        const page = await api.scanRedisKeys(id, 0);
        merge((latest) => ({
          ...latest,
          tables: { ...(latest.tables ?? {}), [cacheKey]: page.keys },
          tablesError: withoutError(latest),
          redisCursor: page.next_cursor,
          redisDone: page.done,
        }));
        return;
      }
      const tables = await api.listTables(id, schema);
      merge((latest) => ({
        ...latest,
        tables: { ...(latest.tables ?? {}), [cacheKey]: tables },
        tablesError: withoutError(latest),
      }));
    } catch (e) {
      // Surface in the tree (error row + retry) instead of an eternal spinner.
      merge((latest) => ({
        ...latest,
        tablesError: { ...(latest.tablesError ?? {}), [cacheKey]: String(e) },
      }));
    }
  },

  loadMoreRedisKeys: async (id, cacheKey) => {
    const start = get().branches[id] ?? {};
    if (start.redisDone || start.redisLoadingMore) return;
    const cursor = start.redisCursor ?? 0;
    set({
      branches: {
        ...get().branches,
        [id]: { ...(get().branches[id] ?? {}), redisLoadingMore: true },
      },
    });
    try {
      const page = await api.scanRedisKeys(id, cursor);
      const latest = get().branches[id] ?? {};
      const prev = latest.tables?.[cacheKey] ?? [];
      // Dedup by name in case SCAN returns the same key twice across pages
      // (Redis SCAN guarantees eventual completeness, not uniqueness).
      const seen = new Set(prev.map((e) => e.name));
      const merged = [...prev];
      for (const k of page.keys) {
        if (!seen.has(k.name)) {
          merged.push(k);
          seen.add(k.name);
        }
      }
      set({
        branches: {
          ...get().branches,
          [id]: {
            ...latest,
            tables: { ...(latest.tables ?? {}), [cacheKey]: merged },
            redisCursor: page.next_cursor,
            redisDone: page.done,
            redisLoadingMore: false,
          },
        },
      });
    } catch (e) {
      const latest = get().branches[id] ?? {};
      set({
        branches: {
          ...get().branches,
          [id]: { ...latest, redisLoadingMore: false },
        },
      });
      toast.error(
        translate(useI18n.getState().lang, "tree.load_more_failed"),
        String(e)
      );
    }
  },
  };
});

export type { ConnStatus };
