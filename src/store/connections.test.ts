import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useConnections } from "./connections";
import type { ConnectionConfig } from "@/types";

function makeCfg(id: string, over: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    id,
    name: id,
    driver: "sqlite",
    file_path: `/tmp/${id}.sqlite`,
    ...over,
  };
}

function resetConnections() {
  useConnections.setState({
    list: [],
    loaded: false,
    status: {},
    versions: {},
    branches: {},
    errors: {},
  });
}

beforeEach(() => {
  resetConnections();
});

afterEach(() => {
  clearMocks();
});

describe("useConnections store", () => {
  it("refresh populates list and sets loaded=true", async () => {
    const list = [makeCfg("c1"), makeCfg("c2")];
    mockIPC((cmd) => {
      if (cmd === "list_connections") return list;
      return undefined;
    });

    await useConnections.getState().refresh();

    const s = useConnections.getState();
    expect(s.list).toEqual(list);
    expect(s.loaded).toBe(true);
  });

  it("refresh adopts a live backend connection and its server version", async () => {
    mockIPC((cmd) => {
      if (cmd === "list_connections") return [makeCfg("c1")];
      if (cmd === "connection_status") return { id: "c1", connected: true, server_version: "16.2" };
      if (cmd === "list_databases") return ["main"];
      return undefined;
    });

    await useConnections.getState().refresh();

    expect(useConnections.getState().status.c1).toBe("connected");
    expect(useConnections.getState().versions.c1).toBe("16.2");
    expect(useConnections.getState().branches.c1?.databases).toEqual(["main"]);
  });

  it("does not adopt a stale refresh result after a user disconnects", async () => {
    let resolveStatus!: (value: { id: string; connected: boolean; server_version: string }) => void;
    let markStatusStarted!: () => void;
    const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
    mockIPC((cmd) => {
      if (cmd === "list_connections") return [makeCfg("c1")];
      if (cmd === "connection_status") {
        markStatusStarted();
        return new Promise((resolve) => { resolveStatus = resolve; });
      }
      if (cmd === "disconnect") return null;
      return undefined;
    });

    const refresh = useConnections.getState().refresh();
    await statusStarted;
    await useConnections.getState().disconnect("c1");
    resolveStatus({ id: "c1", connected: true, server_version: "16.2" });
    await refresh;

    expect(useConnections.getState().status.c1).toBe("disconnected");
    expect(useConnections.getState().versions.c1).toBeUndefined();
  });

  it("does not reintroduce a connection deleted during list refresh", async () => {
    let resolveList!: (value: ConnectionConfig[]) => void;
    let markListStarted!: () => void;
    const listStarted = new Promise<void>((resolve) => { markListStarted = resolve; });
    useConnections.setState({ list: [makeCfg("c1")], status: { c1: "connected" } });
    mockIPC((cmd) => {
      if (cmd === "list_connections") {
        markListStarted();
        return new Promise((resolve) => { resolveList = resolve; });
      }
      if (cmd === "delete_connection") return true;
      return undefined;
    });

    const refresh = useConnections.getState().refresh();
    await listStarted;
    await useConnections.getState().remove("c1");
    resolveList([makeCfg("c1")]);
    await refresh;

    expect(useConnections.getState().list).toEqual([]);
    expect(useConnections.getState().status.c1).toBeUndefined();
  });

  it("save appends a new connection and replaces existing by id", async () => {
    const existing = makeCfg("c1", { name: "old" });
    useConnections.setState({ list: [existing] });

    const saved = makeCfg("c1", { name: "renamed" });
    mockIPC((cmd, payload) => {
      if (cmd === "save_connection") {
        // server echoes back
        return (payload as { config: ConnectionConfig }).config;
      }
      return undefined;
    });

    const returned = await useConnections.getState().save(saved);
    expect(returned).toEqual(saved);
    const s = useConnections.getState();
    expect(s.list).toHaveLength(1);
    expect(s.list[0].name).toBe("renamed");

    // now save a brand new one
    const fresh = makeCfg("c2");
    const returned2 = await useConnections.getState().save(fresh);
    expect(returned2).toEqual(fresh);
    const ids = useConnections.getState().list.map((c) => c.id).sort();
    expect(ids).toEqual(["c1", "c2"]);
  });

  it("save clears cached branch and version when the backend dropped the connection", async () => {
    useConnections.setState({
      list: [makeCfg("c1")],
      status: { c1: "connected" },
      versions: { c1: "old-version" },
      branches: { c1: { databases: ["old-db"] } },
    });
    mockIPC((cmd, payload) => {
      if (cmd === "save_connection") return (payload as { config: ConnectionConfig }).config;
      if (cmd === "connection_status") return { id: "c1", connected: false, server_version: null };
      return undefined;
    });

    await useConnections.getState().save(makeCfg("c1", { file_path: "/tmp/new.sqlite" }));

    const state = useConnections.getState();
    expect(state.status.c1).toBe("disconnected");
    expect(state.branches.c1).toBeUndefined();
    expect(state.versions.c1).toBeUndefined();
  });

  it("does not apply a stale save status after a new connect completes", async () => {
    let resolveStatus!: (value: { id: string; connected: boolean; server_version: null }) => void;
    let markStatusStarted!: () => void;
    const statusStarted = new Promise<void>((resolve) => { markStatusStarted = resolve; });
    useConnections.setState({ list: [makeCfg("c1")], status: { c1: "connected" } });
    mockIPC((cmd, payload) => {
      if (cmd === "save_connection") return (payload as { config: ConnectionConfig }).config;
      if (cmd === "connection_status") {
        markStatusStarted();
        return new Promise((resolve) => { resolveStatus = resolve; });
      }
      if (cmd === "connect") return { id: "c1", connected: true, server_version: "new-version" };
      if (cmd === "list_databases") return ["fresh-db"];
      return undefined;
    });

    const saving = useConnections.getState().save(makeCfg("c1", { file_path: "/tmp/edited.sqlite" }));
    await statusStarted;
    await useConnections.getState().connect("c1");
    resolveStatus({ id: "c1", connected: false, server_version: null });
    await saving;

    const state = useConnections.getState();
    expect(state.status.c1).toBe("connected");
    expect(state.versions.c1).toBe("new-version");
    expect(state.branches.c1?.databases).toEqual(["fresh-db"]);
  });

  it("applies a save result when an unrelated connection changes", async () => {
    let resolveSave!: (value: ConnectionConfig) => void;
    let markSaveStarted!: () => void;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    useConnections.setState({ list: [makeCfg("c1"), makeCfg("c2")] });
    mockIPC((cmd) => {
      if (cmd === "save_connection") {
        markSaveStarted();
        return new Promise((resolve) => { resolveSave = resolve; });
      }
      if (cmd === "connect") return { id: "c2", connected: true, server_version: "8.0" };
      if (cmd === "list_databases") return ["main"];
      if (cmd === "connection_status") return { id: "c1", connected: false, server_version: null };
      return undefined;
    });

    const edited = makeCfg("c1", { name: "renamed" });
    const saving = useConnections.getState().save(edited);
    await saveStarted;
    await useConnections.getState().connect("c2");
    resolveSave(edited);
    await saving;

    expect(useConnections.getState().list.find((c) => c.id === "c1")?.name).toBe("renamed");
  });

  it("remove strips the connection from list, status and branches", async () => {
    useConnections.setState({
      list: [makeCfg("c1"), makeCfg("c2")],
      status: { c1: "connected", c2: "disconnected" },
      branches: {
        c1: { databases: ["main"] },
        c2: { databases: ["main"] },
      },
    });

    mockIPC((cmd) => {
      if (cmd === "delete_connection") return true;
      return undefined;
    });

    await useConnections.getState().remove("c1");

    const s = useConnections.getState();
    expect(s.list.map((c) => c.id)).toEqual(["c2"]);
    expect(s.status).toEqual({ c2: "disconnected" });
    expect(s.branches).toEqual({ c2: { databases: ["main"] } });
  });

  it("connect on success sets status=connected, records version, and loads databases", async () => {
    useConnections.setState({ list: [makeCfg("c1")] });

    mockIPC((cmd, payload) => {
      if (cmd === "connect") {
        const { id } = payload as { id: string };
        return { id, connected: true, server_version: "8.0.40" };
      }
      if (cmd === "list_databases") {
        return ["main", "logs"];
      }
      return undefined;
    });

    await useConnections.getState().connect("c1");

    const s = useConnections.getState();
    expect(s.status.c1).toBe("connected");
    expect(s.versions.c1).toBe("8.0.40");
    expect(s.errors.c1).toBeUndefined();
    expect(s.branches.c1?.databases).toEqual(["main", "logs"]);
    expect(s.branches.c1?.loading).toBe(false);
  });

  it("connect on failure sets status=error, records error, and rethrows", async () => {
    useConnections.setState({ list: [makeCfg("c1")] });

    mockIPC((cmd) => {
      if (cmd === "connect") throw new Error("auth failed");
      return undefined;
    });

    await expect(useConnections.getState().connect("c1")).rejects.toThrow(
      "auth failed"
    );

    const s = useConnections.getState();
    expect(s.status.c1).toBe("error");
    expect(s.errors.c1).toContain("auth failed");
  });

  it("disconnect clears branches and flips status to disconnected", async () => {
    useConnections.setState({
      status: { c1: "connected" },
      branches: { c1: { databases: ["main"] } },
    });
    mockIPC((cmd) => {
      if (cmd === "disconnect") return null;
      return undefined;
    });

    await useConnections.getState().disconnect("c1");

    const s = useConnections.getState();
    expect(s.status.c1).toBe("disconnected");
    expect(s.branches.c1).toBeUndefined();
  });
});
