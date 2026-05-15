import { create } from "zustand";
import { api } from "@/lib/api";
import type { ConnectionConfig, TreeEntry } from "@/types";

type ConnStatus = "disconnected" | "connecting" | "connected" | "error";

interface Branch {
  loading?: boolean;
  error?: string;
  databases?: string[];
  schemas?: Record<string, string[]>;
  tables?: Record<string, TreeEntry[]>;
  /** Redis-only: last cursor returned by SCAN; 0 = exhausted. */
  redisCursor?: number;
  redisDone?: boolean;
  redisLoadingMore?: boolean;
}

interface ConnectionsState {
  list: ConnectionConfig[];
  loaded: boolean;
  status: Record<string, ConnStatus>;
  versions: Record<string, string | undefined>;
  branches: Record<string, Branch>;
  errors: Record<string, string | undefined>;

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
  loadSchemas: (id: string, database?: string) => Promise<void>;
  /** Redis-only: append next batch of keys using the saved cursor. */
  loadMoreRedisKeys: (id: string, cacheKey: string) => Promise<void>;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  list: [],
  loaded: false,
  status: {},
  versions: {},
  branches: {},
  errors: {},

  refresh: async () => {
    const list = await api.listConnections();
    set({ list, loaded: true });
    // re-fetch trees for currently-connected pools so stale cache clears
    for (const c of list) {
      if (get().status[c.id] === "connected") {
        await get().refreshBranch(c.id);
      }
    }
  },

  refreshBranch: async (id) => {
    const branches = { ...get().branches };
    delete branches[id];
    set({ branches });
    if (get().status[id] === "connected") {
      await get().loadDatabases(id);
    }
  },

  save: async (cfg) => {
    const saved = await api.saveConnection(cfg);
    const list = [...get().list.filter((c) => c.id !== saved.id), saved];
    set({ list });
    return saved;
  },

  remove: async (id) => {
    await api.deleteConnection(id);
    const { [id]: _s, ...status } = get().status;
    const { [id]: _b, ...branches } = get().branches;
    set({
      list: get().list.filter((c) => c.id !== id),
      status,
      branches,
    });
  },

  connect: async (id) => {
    set({ status: { ...get().status, [id]: "connecting" }, errors: { ...get().errors, [id]: undefined } });
    try {
      const s = await api.connect(id);
      set({
        status: { ...get().status, [id]: "connected" },
        versions: { ...get().versions, [id]: s.server_version ?? undefined },
      });
      await get().loadDatabases(id);
    } catch (e: unknown) {
      set({
        status: { ...get().status, [id]: "error" },
        errors: { ...get().errors, [id]: String(e) },
      });
      throw e;
    }
  },

  disconnect: async (id) => {
    await api.disconnect(id);
    const branches = { ...get().branches };
    delete branches[id];
    set({
      status: { ...get().status, [id]: "disconnected" },
      branches,
    });
  },

  loadDatabases: async (id) => {
    const existing = get().branches[id] ?? {};
    set({ branches: { ...get().branches, [id]: { ...existing, loading: true } } });
    try {
      const databases = await api.listDatabases(id);
      set({
        branches: {
          ...get().branches,
          [id]: { ...existing, databases, loading: false },
        },
      });
    } catch (e: unknown) {
      set({
        branches: {
          ...get().branches,
          [id]: { ...existing, error: String(e), loading: false },
        },
      });
    }
  },

  loadSchemas: async (id, database) => {
    const cur = get().branches[id] ?? {};
    try {
      const schemas = await api.listSchemas(id, database);
      set({
        branches: {
          ...get().branches,
          [id]: {
            ...cur,
            schemas: { ...(cur.schemas ?? {}), [database ?? "_"]: schemas },
          },
        },
      });
    } catch (e) {
      console.error(e);
    }
  },

  loadTables: async (id, cacheKey, schema) => {
    const cur = get().branches[id] ?? {};
    const driver = get().list.find((c) => c.id === id)?.driver;
    try {
      // Redis: use the paginated scan path so we can drive "Load more" later.
      if (driver === "redis") {
        const page = await api.scanRedisKeys(id, 0);
        set({
          branches: {
            ...get().branches,
            [id]: {
              ...cur,
              tables: { ...(cur.tables ?? {}), [cacheKey]: page.keys },
              redisCursor: page.next_cursor,
              redisDone: page.done,
            },
          },
        });
        return;
      }
      const tables = await api.listTables(id, schema);
      set({
        branches: {
          ...get().branches,
          [id]: {
            ...cur,
            tables: { ...(cur.tables ?? {}), [cacheKey]: tables },
          },
        },
      });
    } catch (e) {
      console.error(e);
    }
  },

  loadMoreRedisKeys: async (id, cacheKey) => {
    const cur = get().branches[id] ?? {};
    if (cur.redisDone || cur.redisLoadingMore) return;
    const cursor = cur.redisCursor ?? 0;
    set({
      branches: {
        ...get().branches,
        [id]: { ...cur, redisLoadingMore: true },
      },
    });
    try {
      const page = await api.scanRedisKeys(id, cursor);
      const prev = cur.tables?.[cacheKey] ?? [];
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
            ...cur,
            tables: { ...(cur.tables ?? {}), [cacheKey]: merged },
            redisCursor: page.next_cursor,
            redisDone: page.done,
            redisLoadingMore: false,
          },
        },
      });
    } catch (e) {
      console.error(e);
      set({
        branches: {
          ...get().branches,
          [id]: { ...cur, redisLoadingMore: false },
        },
      });
    }
  },
}));

export type { ConnStatus };
