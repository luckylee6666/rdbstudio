import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerMonitorView } from "./ServerMonitorView";
import { api } from "@/lib/api";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import type { ServerMonitorSnapshot } from "@/types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(version: string): ServerMonitorSnapshot {
  return {
    driver: "postgres",
    server_version: version,
    metrics: [],
    processes: [{
      id: "123", user: "worker", database: "test", client: "local",
      state: "active", command: "SELECT", duration_sec: 1,
      wait_info: null, query: "SELECT 1", is_self: false, killable: true,
    }],
  };
}

function selectConnection(id: string) {
  fireEvent.change(screen.getByLabelText("Connection"), { target: { value: id } });
}

describe("ServerMonitorView", () => {
  beforeEach(() => {
    useI18n.setState({ lang: "en" });
    useConnections.setState({
      list: [
        { id: "a", name: "Server A", driver: "postgres" },
        { id: "b", name: "Server B", driver: "postgres" },
      ],
      status: { a: "connected", b: "connected" },
      errors: {}, branches: {}, versions: {}, loaded: true,
    });
    vi.spyOn(api, "killServerProcess").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each(["success", "error"])("ignores an old connection's %s while the new connection loads", async (outcome) => {
    const a = deferred<ServerMonitorSnapshot>();
    const b = deferred<ServerMonitorSnapshot>();
    vi.spyOn(api, "serverMonitorSnapshot").mockImplementation((id) => id === "a" ? a.promise : b.promise);
    render(<ServerMonitorView initialConnectionId="a" />);
    selectConnection("b");

    await act(async () => {
      if (outcome === "success") a.resolve(snapshot("stale A"));
      else a.reject(new Error("old connection error"));
    });
    expect(screen.queryByText("stale A")).not.toBeInTheDocument();
    expect(screen.queryByText("old connection error")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    await act(async () => { b.resolve(snapshot("current B")); });
    expect(screen.getByText("current B")).toBeInTheDocument();
  });

  it("ignores the first A request after switching A to B to A", async () => {
    const oldA = deferred<ServerMonitorSnapshot>();
    const b = deferred<ServerMonitorSnapshot>();
    const newA = deferred<ServerMonitorSnapshot>();
    vi.spyOn(api, "serverMonitorSnapshot")
      .mockReturnValueOnce(oldA.promise).mockReturnValueOnce(b.promise).mockReturnValueOnce(newA.promise);
    render(<ServerMonitorView initialConnectionId="a" />);
    selectConnection("b");
    selectConnection("a");
    await act(async () => { newA.resolve(snapshot("current A")); });
    await act(async () => {
      oldA.resolve(snapshot("stale A"));
      b.resolve(snapshot("stale B"));
    });
    expect(screen.getByText("current A")).toBeInTheDocument();
    expect(screen.queryByText("stale A")).not.toBeInTheDocument();
    expect(screen.queryByText("stale B")).not.toBeInTheDocument();
  });

  it("keeps the latest automatic refresh when responses arrive out of order", async () => {
    vi.useFakeTimers();
    const older = deferred<ServerMonitorSnapshot>();
    const newer = deferred<ServerMonitorSnapshot>();
    vi.spyOn(api, "serverMonitorSnapshot").mockResolvedValueOnce(snapshot("initial"))
      .mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    render(<ServerMonitorView initialConnectionId="a" />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Auto refresh"), { target: { value: "2" } });
    await act(async () => { vi.advanceTimersByTime(4000); });
    await act(async () => { newer.resolve(snapshot("newest")); });
    await act(async () => { older.resolve(snapshot("older")); });
    expect(screen.getByText("newest")).toBeInTheDocument();
    expect(screen.queryByText("older")).not.toBeInTheDocument();
  });

  it("dismisses a pending termination when switching connections", async () => {
    vi.spyOn(api, "serverMonitorSnapshot").mockResolvedValue(snapshot("server"));
    render(<ServerMonitorView initialConnectionId="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Kill" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    selectConnection("b");
    await act(async () => {});
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.killServerProcess).not.toHaveBeenCalled();
  });

  it("does not reload an old connection when termination finishes after switching", async () => {
    const kill = deferred<void>();
    vi.mocked(api.killServerProcess).mockReturnValue(kill.promise);
    vi.spyOn(api, "serverMonitorSnapshot").mockImplementation(async (id) => snapshot(`server ${id}`));
    render(<ServerMonitorView initialConnectionId="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Kill" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Kill" }));
    expect(api.killServerProcess).toHaveBeenCalledWith("a", "123", false);
    selectConnection("b");
    await screen.findByText("server b");
    await act(async () => { kill.resolve(); });
    expect(api.serverMonitorSnapshot).toHaveBeenCalledTimes(2);
    expect(screen.getByText("server b")).toBeInTheDocument();
  });

  it("rechecks read-only state when confirming termination", async () => {
    vi.spyOn(api, "serverMonitorSnapshot").mockResolvedValue(snapshot("server"));
    render(<ServerMonitorView initialConnectionId="a" />);
    fireEvent.click(await screen.findByRole("button", { name: "Kill" }));
    act(() => useConnections.setState({
      list: useConnections.getState().list.map((c) => c.id === "a" ? { ...c, read_only: true } : c),
    }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Kill" }));
    expect(api.killServerProcess).not.toHaveBeenCalled();
  });

  it.each(["switch", "unmount"])("does not request a snapshot after a slow connection finishes following %s", async (action) => {
    const connected = deferred<{ id: string; connected: boolean; server_version: string }>();
    useConnections.setState({ status: { a: "disconnected", b: "connected" } });
    vi.spyOn(api, "connect").mockReturnValue(connected.promise);
    vi.spyOn(api, "listDatabases").mockResolvedValue([]);
    vi.spyOn(api, "serverMonitorSnapshot").mockResolvedValue(snapshot("server B"));
    const { unmount } = render(<ServerMonitorView initialConnectionId="a" />);
    if (action === "switch") selectConnection("b");
    else unmount();
    await act(async () => { connected.resolve({ id: "a", connected: true, server_version: "test" }); });
    expect(api.serverMonitorSnapshot).not.toHaveBeenCalledWith("a");
  });
});
