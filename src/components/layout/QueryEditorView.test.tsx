import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryEditorView } from "./QueryEditorView";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import type { ConnectionConfig, WorkspaceTab } from "@/types";

vi.mock("@/components/editor/CodeMirror", () => ({
  CodeMirrorEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="SQL editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("@/components/grid/DataGrid", () => ({
  DataGrid: ({ rows }: { rows: unknown[][] }) => (
    <div data-testid="result-grid">{rows.map((row) => row.map(String).join(" · ")).join(" / ")}</div>
  ),
}));

describe("QueryEditorView buffer persistence", () => {
  const tab: WorkspaceTab = {
    id: "query:buffer-test",
    kind: "query",
    title: "Query",
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  });

  it("flushes the latest SQL when switching tabs inside the debounce window", () => {
    const { unmount } = render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: "SELECT 'kept';" },
    });

    unmount();

    expect(localStorage.getItem(`rdb:buf:${tab.id}`)).toBe("SELECT 'kept';");
  });

  it("does not recreate storage for a deliberately closed tab", () => {
    const { unmount } = render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: "SELECT 'closed';" },
    });
    act(() => useWorkspace.setState({ tabs: [], activeTabId: null }));

    unmount();

    expect(localStorage.getItem(`rdb:buf:${tab.id}`)).toBeNull();
  });
});

describe("QueryEditorView script failure reporting", () => {
  const tab: WorkspaceTab = { id: "query:script", kind: "query", title: "Query" };
  const mysql: ConnectionConfig = {
    id: "my",
    name: "mysql-test",
    driver: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    group: null,
    ssl_mode: "disable",
  };

  const calls: Record<string, unknown>[] = [];

  function runScript(outcome: Record<string, unknown>, sql?: string) {
    mockIPC((command, payload) => {
      if (command !== "execute_script") return undefined;
      calls.push(payload as Record<string, unknown>);
      return outcome;
    });
    render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: sql ?? "ALTER TABLE t ADD COLUMN a INT;\nSELECT bad;" },
    });
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
  }

  beforeEach(() => {
    clearMocks();
    calls.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    useI18n.setState({ lang: "zh" });
    useConnections.setState({
      list: [mysql],
      loaded: true,
      status: { my: "connected" },
      versions: {},
      branches: {},
      errors: {},
      treeFilter: "",
    });
    useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  });

  afterEach(() => clearMocks());

  it("promises a full rollback only when the backend confirms one", async () => {
    runScript({
      status: "failed",
      failed_index: 1,
      statements: 2,
      error: "boom",
      rollback: "complete",
    });

    await waitFor(() =>
      expect(screen.getByText(/已整体回滚/)).toBeInTheDocument()
    );
    expect(calls[0]?.atomic).toBe(true);
  });

  it("warns that MySQL already applied the DDL when the rollback was partial", async () => {
    runScript({
      status: "failed",
      failed_index: 1,
      statements: 2,
      error: "boom",
      rollback: "partial",
    });

    await waitFor(() =>
      expect(screen.getByText(/结构变更已经生效/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/已整体回滚/)).toBeNull();
  });

  it("sends a self-managed transaction as one non-atomic script", async () => {
    // Statement by statement these would scatter across pooled connections and
    // the ROLLBACK would land on a connection that never saw the UPDATE.
    runScript(
      {
        status: "failed",
        failed_index: 2,
        statements: 3,
        error: "boom",
        rollback: "self_managed",
      },
      "BEGIN;\nUPDATE t SET a = 1;\nROLLBACK;"
    );

    await waitFor(() =>
      expect(screen.getByText(/脚本自行管理事务/)).toBeInTheDocument()
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.atomic).toBe(false);
    expect(calls[0]?.sqls).toEqual([
      "BEGIN",
      "UPDATE t SET a = 1",
      "ROLLBACK",
    ]);
  });
  it("recognizes transaction controls after SQL comments", async () => {
    runScript({
      status: "failed", failed_index: 2, statements: 3,
      error: "boom", rollback: "self_managed",
    }, "-- start transaction\nBEGIN; UPDATE t SET a = 1; /* discard */ ROLLBACK;");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.atomic).toBe(false);
  });

  it("shows each result set and binds the script to its query tab", async () => {
    const r1 = { columns: [{ name: "n", data_type: "INT" }], rows: [[1]], rows_affected: null, elapsed_ms: 1, truncated: false };
    const r2 = { ...r1, rows: [[2]] };
    const payloads: Array<Record<string, unknown>> = [];
    mockIPC((command, args) => {
      if (command === "execute_script") { payloads.push(args as Record<string, unknown>); return { status: "ok", result: r2, results: [r1, r2], total_affected: 0, statements: 2 }; }
      if (command === "editor_session_status") return { connected: true, in_transaction: false };
      return undefined;
    });
    render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), { target: { value: "SELECT 1; SELECT 2;" } });
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
    expect(await screen.findByTestId("result-grid")).toHaveTextContent("2");
    fireEvent.click(screen.getByRole("button", { name: /结果 1/ }));
    expect(screen.getByTestId("result-grid")).toHaveTextContent("1");
    fireEvent.click(screen.getByRole("button", { name: /结果 2/ }));
    expect(screen.getByTestId("result-grid")).toHaveTextContent("2");
    expect(payloads[0]?.sessionId).toBe(tab.id);
  });

  it("closes the old tab session before running on a newly selected connection", async () => {
    const pg: ConnectionConfig = { ...mysql, id: "pg", name: "pg-test", driver: "postgres", port: 5432 };
    useConnections.setState({ list: [mysql, pg], status: { my: "connected", pg: "connected" } });
    expect(useConnections.getState().list.map((item) => item.id)).toEqual(["my", "pg"]);
    const calls: Array<{ command: string; payload: Record<string, unknown> }> = [];
    mockIPC((command, payload) => {
      const args = payload as Record<string, unknown>;
      calls.push({ command, payload: args });
      if (command === "execute_query") return { columns: [{ name: "connection", data_type: "text" }], rows: [[args.id]], rows_affected: null, elapsed_ms: 1, truncated: false };
      if (command === "editor_session_status") return { connected: true, in_transaction: false };
      return undefined;
    });
    render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), { target: { value: "SELECT 1" } });
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
    await waitFor(() => expect(calls.some((call) => call.command === "execute_query" && call.payload.id === "my")).toBe(true));
    await waitFor(() => expect(calls.some((call) => call.command === "editor_session_status")).toBe(true));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pg" } });
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("pg"));
    expect(calls.some((call) => call.command === "close_editor_session")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
    await waitFor(() => expect(calls.some((call) => call.command === "execute_query" && call.payload.id === "pg")).toBe(true));
    const closeIndex = calls.findIndex((call) => call.command === "close_editor_session");
    const newQueryIndex = calls.findIndex((call) => call.command === "execute_query" && call.payload.id === "pg");
    expect(closeIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(newQueryIndex);
    expect(calls[newQueryIndex]?.payload.sessionId).toBe(tab.id);
  });

  it("requires resetting a lost open transaction instead of sending COMMIT to a dead session", async () => {
    useI18n.setState({ lang: "en" });
    const closeSession = vi.fn();
    mockIPC((command) => {
      if (command === "execute_query") return { columns: [], rows: [], rows_affected: null, elapsed_ms: 1, truncated: false };
      if (command === "editor_session_status") return { connected: false, in_transaction: true };
      if (command === "close_editor_session") { closeSession(); return undefined; }
      return undefined;
    });
    render(<QueryEditorView tab={tab} />);
    fireEvent.click(screen.getByRole("button", { name: "Begin transaction" }));
    expect(await screen.findByText("Session lost")).toBeInTheDocument();
    // A dead session offers only a reset — never a COMMIT into the void.
    expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset session" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(closeSession).toHaveBeenCalledOnce());
  });

  it("asks before switching away from an uncommitted transaction", async () => {
    useI18n.setState({ lang: "en" });
    const pg: ConnectionConfig = { ...mysql, id: "pg", name: "pg-test", driver: "postgres", port: 5432 };
    useConnections.setState({ list: [mysql, pg], status: { my: "connected", pg: "connected" } });
    const closeSession = vi.fn();
    mockIPC((command) => {
      if (command === "execute_query") return { columns: [], rows: [], rows_affected: null, elapsed_ms: 1, truncated: false };
      if (command === "editor_session_status") return { connected: true, in_transaction: true };
      if (command === "close_editor_session") { closeSession(); return undefined; }
      return undefined;
    });
    render(<QueryEditorView tab={tab} />);
    fireEvent.click(screen.getByRole("button", { name: "Begin transaction" }));
    await waitFor(() => expect(screen.getByText("In transaction")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pg" } });
    expect(screen.getByRole("dialog", { name: "Switch database connection" })).toBeInTheDocument();
    expect(closeSession).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch and roll back" }));
    await waitFor(() => expect(closeSession).toHaveBeenCalledOnce());
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("pg");
  });

});

describe("QueryEditorView explain analyze guard", () => {
  const tab: WorkspaceTab = {
    id: "query:analyze",
    kind: "query",
    title: "Query",
  };
  const pg: ConnectionConfig = {
    id: "pg",
    name: "pg-test",
    driver: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    group: null,
    ssl_mode: "disable",
  };

  function pickExplainAnalyze(sql: string) {
    mockIPC(() => undefined);
    render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: sql },
    });
    fireEvent.click(screen.getByRole("button", { name: "Explain options" }));
    fireEvent.click(screen.getByRole("button", { name: "Explain Analyze" }));
  }

  const openedAnalyzeTab = () =>
    useWorkspace.getState().tabs.find((t) => t.id.startsWith("explain-analyze:"));

  beforeEach(() => {
    clearMocks();
    localStorage.clear();
    sessionStorage.clear();
    useI18n.setState({ lang: "en" });
    useConnections.setState({
      list: [pg],
      loaded: true,
      status: { pg: "connected" },
      versions: {},
      branches: {},
      errors: {},
      treeFilter: "",
    });
    useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  });

  afterEach(() => clearMocks());

  it("opens an analyze tab directly for read-only statements", () => {
    pickExplainAnalyze("SELECT * FROM users");

    expect(screen.queryByText("Run this statement for real?")).toBeNull();
    expect(openedAnalyzeTab()?.sql).toBe("SELECT * FROM users");
  });

  it("asks for confirmation before analyzing a write", () => {
    pickExplainAnalyze("DELETE FROM users");

    expect(
      screen.getByText("Run this statement for real?")
    ).toBeInTheDocument();
    expect(openedAnalyzeTab()).toBeUndefined();
  });

  it("opens the analyze tab once the write confirmation is accepted", () => {
    pickExplainAnalyze("DELETE FROM users");
    fireEvent.click(screen.getByRole("button", { name: "Run anyway" }));

    expect(openedAnalyzeTab()?.sql).toBe("DELETE FROM users");
  });
});
