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
