import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConnectionConfig } from "@/types";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { useToasts } from "@/store/toasts";
import { ConnectionTree } from "./ConnectionTree";

const connections: ConnectionConfig[] = [
  {
    id: "local",
    name: "local-9.0",
    driver: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    group: null,
    ssl_mode: "disable",
  },
  {
    id: "grouped",
    name: "思誉-工具",
    driver: "mysql",
    host: "db.internal",
    port: 3306,
    username: "root",
    group: "思誉",
    ssl_mode: "disable",
  },
];

const originalElementFromPoint = document.elementFromPoint;

function installDropTarget(group: string) {
  const zone = document.querySelector(`[data-conn-drop="${group}"]`);
  if (!(zone instanceof Element)) throw new Error(`missing drop target ${group}`);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => zone,
  });
}

function startDraggingLocal() {
  const row = screen.getByText("local-9.0").closest("button");
  if (!row) throw new Error("missing connection row");
  fireEvent.mouseDown(row, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(window, { clientX: 120, clientY: 120 });
}

describe("ConnectionTree connection dragging", () => {
  beforeEach(() => {
    clearMocks();
    localStorage.clear();
    useI18n.setState({ lang: "zh" });
    useToasts.setState({ items: [] });
    useConnections.setState({
      list: connections,
      loaded: true,
      status: {},
      versions: {},
      branches: {},
      errors: {},
      treeFilter: "",
    });
  });

  afterEach(() => {
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: originalElementFromPoint,
    });
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    clearMocks();
  });

  it("shows the target preview and confirms a successful move", async () => {
    const saved: ConnectionConfig[] = [];
    mockIPC((command, payload) => {
      if (command === "list_connections") return connections;
      if (command === "save_connection") {
        const config = (payload as { config: ConnectionConfig }).config;
        saved.push(config);
        return config;
      }
      return undefined;
    });

    render(<ConnectionTree />);
    installDropTarget("思誉");
    startDraggingLocal();

    expect(screen.getByText("移到「思誉」")).toBeInTheDocument();
    expect(document.body.style.cursor).toBe("grabbing");

    fireEvent.mouseUp(window, { clientX: 120, clientY: 120 });

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].group).toBe("思誉");
    expect(useToasts.getState().items.at(-1)?.title).toBe("已移到「思誉」");
    expect(document.body.style.cursor).toBe("");
  });

  it("cancels cleanly when the window loses focus", async () => {
    let saveCalls = 0;
    mockIPC((command) => {
      if (command === "list_connections") return connections;
      if (command === "save_connection") saveCalls += 1;
      return undefined;
    });

    render(<ConnectionTree />);
    installDropTarget("思誉");
    startDraggingLocal();
    expect(screen.getByText("移到「思誉」")).toBeInTheDocument();

    fireEvent.blur(window);

    await waitFor(() =>
      expect(screen.queryByText("移到「思誉」")).not.toBeInTheDocument()
    );
    expect(saveCalls).toBe(0);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("keeps the connection in place and reports a failed move", async () => {
    mockIPC((command) => {
      if (command === "list_connections") return connections;
      if (command === "save_connection") throw new Error("disk full");
      return undefined;
    });

    render(<ConnectionTree />);
    installDropTarget("思誉");
    startDraggingLocal();
    fireEvent.mouseUp(window, { clientX: 120, clientY: 120 });

    await waitFor(() =>
      expect(useToasts.getState().items.at(-1)?.title).toBe("移动连接失败")
    );
    expect(useConnections.getState().list.find((item) => item.id === "local")?.group).toBeNull();
  });
});
