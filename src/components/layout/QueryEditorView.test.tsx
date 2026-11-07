import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("loads generated SQL but prefers subsequent saved edits when restored", () => {
    const seeded = { ...tab, sql: "SELECT 42;" };
    const first = render(<QueryEditorView tab={seeded} />);
    expect(screen.getByLabelText("SQL editor")).toHaveValue("SELECT 42;");
    fireEvent.change(screen.getByLabelText("SQL editor"), { target: { value: "SELECT 43;" } });
    first.unmount();
    render(<QueryEditorView tab={seeded} />);
    expect(screen.getByLabelText("SQL editor")).toHaveValue("SELECT 43;");
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

  it("sends the original transaction script for backend atomicity detection", async () => {
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
    expect(calls[0]?.atomic).toBe(true);
    expect(calls[0]?.sourceScript).toBe(true);
    expect(calls[0]?.sqls).toEqual(["BEGIN;\nUPDATE t SET a = 1;\nROLLBACK;"]);
  });
  it("preserves comments and transaction controls for backend parsing", async () => {
    runScript({
      status: "failed", failed_index: 2, statements: 3,
      error: "boom", rollback: "self_managed",
    }, "-- start transaction\nBEGIN; UPDATE t SET a = 1; /* discard */ ROLLBACK;");
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.atomic).toBe(true);
    expect(calls[0]?.sourceScript).toBe(true);
  });

  it("passes DELIMITER routines and internal semicolons unchanged", async () => {
    const source = "DELIMITER $$\nCREATE PROCEDURE f() BEGIN SELECT 'a;b'; SELECT 2; END$$\nDELIMITER ;\nCALL f();";
    runScript({ status: "failed", failed_index: 1, statements: 2, error: "example", rollback: "partial" }, source);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual(expect.objectContaining({ sqls: [source], sourceScript: true, atomic: true, sessionId: tab.id }));
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
      if (command === "execute_script") { const result = { columns: [{ name: "connection", data_type: "text" }], rows: [[args.id]], rows_affected: null, elapsed_ms: 1, truncated: false }; return { status: "ok", result, results: [result], statements: 1, total_affected: 0 }; }
      if (command === "editor_session_status") return { connected: true, in_transaction: false };
      return undefined;
    });
    render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), { target: { value: "SELECT 1" } });
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
    await waitFor(() => expect(calls.some((call) => call.command === "execute_script" && call.payload.id === "my")).toBe(true));
    await waitFor(() => expect(calls.some((call) => call.command === "editor_session_status")).toBe(true));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "pg" } });
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("pg"));
    expect(calls.some((call) => call.command === "close_editor_session")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
    await waitFor(() => expect(calls.some((call) => call.command === "execute_script" && call.payload.id === "pg")).toBe(true));
    const closeIndex = calls.findIndex((call) => call.command === "close_editor_session");
    const newQueryIndex = calls.findIndex((call) => call.command === "execute_script" && call.payload.id === "pg");
    expect(closeIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(newQueryIndex);
    expect(calls[newQueryIndex]?.payload.sessionId).toBe(tab.id);
  });

  it("requires resetting a lost open transaction instead of sending COMMIT to a dead session", async () => {
    useI18n.setState({ lang: "en" });
    const closeSession = vi.fn();
    mockIPC((command) => {
      if (command === "execute_script") { const result = { columns: [], rows: [], rows_affected: null, elapsed_ms: 1, truncated: false }; return { status: "ok", result, results: [result], statements: 1, total_affected: 0 }; }
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
      if (command === "execute_script") { const result = { columns: [], rows: [], rows_affected: null, elapsed_ms: 1, truncated: false }; return { status: "ok", result, results: [result], statements: 1, total_affected: 0 }; }
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
    mockIPC(command => command === "editor_session_identity" ? "source-identity" : undefined);
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

  it("opens an analyze tab directly for read-only statements", async () => {
    pickExplainAnalyze("SELECT * FROM users");

    expect(screen.queryByText("Run this statement for real?")).toBeNull();
    await waitFor(() => expect(openedAnalyzeTab()?.sql).toBe("SELECT * FROM users"));
    expect(openedAnalyzeTab()).toMatchObject({ sourceQueryId: tab.id, sourceSessionIdentity: "source-identity", explainRequested: true });
  });

  it("asks for confirmation before analyzing a write", () => {
    pickExplainAnalyze("DELETE FROM users");

    expect(
      screen.getByText("Run this statement for real?")
    ).toBeInTheDocument();
    expect(openedAnalyzeTab()).toBeUndefined();
  });

  it("opens the analyze tab once the write confirmation is accepted", async () => {
    pickExplainAnalyze("DELETE FROM users");
    fireEvent.click(screen.getByRole("button", { name: "Run anyway" }));

    await waitFor(() => expect(openedAnalyzeTab()?.sql).toBe("DELETE FROM users"));
  });
});

describe("QueryEditorView named parameters", () => {
  const tab: WorkspaceTab = { id: "query:parameters", kind: "query", title: "Query", connectionId: "db", sql: "SELECT :value" };
  const connection: ConnectionConfig = { id: "db", name: "Parameter test", driver: "sqlite", file_path: ":memory:", group: null, ssl_mode: "disable" };
  const execute = vi.fn();
  const inspect = vi.fn();
  const batch = vi.fn();
  const result = { columns: [{ name: "value", data_type: "TEXT" }], rows: [["bound"]], elapsed_ms: 1, truncated: false, rows_affected: null };
  beforeEach(() => {
    localStorage.clear(); sessionStorage.clear(); clearMocks(); execute.mockReset(); inspect.mockReset(); batch.mockReset();
    useI18n.setState({ lang: "en" });
    useConnections.setState({ list: [connection], loaded: true, status: { db: "connected" }, versions: {}, branches: {}, errors: {} });
    useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
    inspect.mockResolvedValue({ names: ["value"], generation: 7 });
    mockIPC((command, payload) => {
      if (command === "query_parameter_names") return inspect(payload);
      if (command === "execute_parameter_batch") return batch(payload);
      if (command === "execute_parameter_query") { execute(payload); return { status: "ok", result, results: [result], statements: 1, total_affected: 0 }; }
      if (command === "execute_query" || command === "execute_script") throw new Error("parameter query must use native binding");
      if (command === "editor_session_status") return { connected: true, in_transaction: false, needs_reset: false };
      return undefined;
    });
  });
  afterEach(() => clearMocks());
  async function prompt() {
    render(<QueryEditorView tab={tab} />);
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByRole("dialog", { name: "Query parameters" });
  }
  it("inspects without executing, then binds the value with captured generation and target", async () => {
    await prompt();
    expect(execute).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ id: "db", sqls: ["SELECT :value"], sessionId: tab.id, sourceScript: true }));
    fireEvent.change(screen.getByLabelText("value · Value"), { target: { value: "'; DROP TABLE x; --" } });
    fireEvent.click(screen.getByRole("button", { name: "Run with parameters" }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute).toHaveBeenCalledWith({ id: "db", request: expect.objectContaining({ sqls: ["SELECT :value"], generation: 7, sessionId: tab.id, sourceScript: true, parameters: [{ name: "value", kind: "text", value: "'; DROP TABLE x; --" }] }) });
    expect(useWorkspace.getState().tabs[0].queryParameterDefaults).toEqual([{ name: "value", kind: "text" }]);
    await screen.findByTestId("result-grid");
  });
  it("keeps a parameterized trigger script intact during inspection and execution", async () => {
    const source = "CREATE TEMP TRIGGER tr AFTER INSERT ON saved BEGIN INSERT INTO audit VALUES('a;b'); END; INSERT INTO saved VALUES(:value);";
    render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), { target: { value: source } });
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByRole("dialog", { name: "Query parameters" });
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ sqls: [source], sourceScript: true }));
    fireEvent.change(screen.getByLabelText("value · Value"), { target: { value: "bound" } });
    fireEvent.click(screen.getByRole("button", { name: "Run with parameters" }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith({ id: "db", request: expect.objectContaining({ sqls: [source], sourceScript: true, atomic: true, generation: 7 }) }));
  });
  it("cancels the prompt without executing or storing a value", async () => {
    await prompt();
    fireEvent.change(screen.getByLabelText("value · Value"), { target: { value: "private" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
    expect(useWorkspace.getState().tabs[0].queryParameterDefaults).toBeUndefined();
  });
  it("invalidates a prompt if an external event replaces the editor buffer", async () => {
    await prompt();
    act(() => window.dispatchEvent(new CustomEvent("set-editor-sql", { detail: { tabId: tab.id, sql: "DELETE FROM saved WHERE id=:value" } })));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(execute).not.toHaveBeenCalled();
    expect(screen.getByText("SQL or target connection changed. Run the query again to review its parameters.")).toBeInTheDocument();
  });
  it("only saves a default after explicitly checking the option", async () => {
    await prompt();
    fireEvent.change(screen.getByLabelText("value · Value"), { target: { value: "explicit" } });
    fireEvent.click(screen.getByLabelText("value · Save default"));
    fireEvent.click(screen.getByRole("button", { name: "Run with parameters" }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(useWorkspace.getState().tabs[0].queryParameterDefaults).toEqual([{ name: "value", kind: "text", value: "explicit" }]);
  });
  it("prevents invalid integers but permits a typed SQL NULL", async () => {
    await prompt();
    fireEvent.change(screen.getByLabelText("value · Type"), { target: { value: "integer" } });
    fireEvent.change(screen.getByLabelText("value · Value"), { target: { value: "9223372036854775808" } });
    expect(screen.getByRole("button", { name: "Run with parameters" })).toBeDisabled();
    fireEvent.click(screen.getByLabelText("value · NULL"));
    fireEvent.click(screen.getByRole("button", { name: "Run with parameters" }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0][0].request.parameters).toEqual([{ name: "value", kind: "integer", value: null }]);
  });
  it("executes the original source with typed sets and navigates only the selected set's results", async () => {
    const results = ["first-a", "first-b", "second-a", "second-b"].map(value => ({ ...result, rows: [[value]] }));
    batch.mockResolvedValue({ status: "ok", result: results[3], results, statements: 4, total_affected: 0,
      sets: [0, 1].map(index => ({ index, first_result: index * 2, result_count: 2, statements: 2, affected: 0 })), failed_set: null });
    await prompt();
    fireEvent.change(screen.getByLabelText("value · Type"), { target: { value: "integer" } });
    fireEvent.change(screen.getByLabelText("value · Value"), { target: { value: "9223372036854775807" } });
    fireEvent.click(screen.getByRole("button", { name: "Batch sets" }));
    await screen.findByLabelText("Set 1 · value");
    expect(inspect).toHaveBeenLastCalledWith(expect.objectContaining({ sourceScript: true, futureSets: true, sqls: [tab.sql] }));
    expect(screen.getByLabelText("Set 1 · value")).toHaveValue("9223372036854775807");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.click(screen.getByLabelText("Set 2 · value · NULL"));
    fireEvent.click(screen.getByRole("button", { name: "Run 2 sets" }));
    await waitFor(() => expect(batch).toHaveBeenCalledOnce());
    expect(batch).toHaveBeenCalledWith({ id: "db", request: expect.objectContaining({ source: tab.sql, atomic: true,
      sessionId: tab.id, generation: 7, sets: [
        [{ name: "value", kind: "integer", value: "9223372036854775807" }],
        [{ name: "value", kind: "integer", value: null }],
      ] }) });
    expect(execute).not.toHaveBeenCalled();
    expect(await screen.findByTestId("result-grid")).toHaveTextContent("second-b");
    expect(screen.getByLabelText("Parameter set result")).toHaveValue("1");
    expect(screen.queryByRole("button", { name: /Set 1 · Result/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Parameter set result"), { target: { value: "0" } });
    expect(screen.getByTestId("result-grid")).toHaveTextContent("first-b");
    fireEvent.click(screen.getByRole("button", { name: /Set 1 · Result 1/ }));
    expect(screen.getByTestId("result-grid")).toHaveTextContent("first-a");
    expect(screen.queryByRole("button", { name: /Set 2 · Result/ })).not.toBeInTheDocument();
    expect(useWorkspace.getState().tabs[0].queryParameterDefaults).toBeUndefined();
    expect(JSON.stringify(localStorage)).not.toContain("9223372036854775807");
    // Reopening within this mounted editor recovers the batch without persisting it.
    await new Promise(resolve => setTimeout(resolve, 160));
    fireEvent.click(screen.getByRole("button", { name: /^Run/ }));
    await screen.findByRole("dialog", { name: "Query parameters" });
    fireEvent.click(screen.getByRole("button", { name: "Batch sets" }));
    expect(await screen.findByLabelText("Set 1 · value")).toHaveValue("9223372036854775807");
    expect(screen.getByLabelText("Set 2 · value · NULL")).toBeChecked();
  });
  it("reports the failed set and statement with the batch rollback status", async () => {
    batch.mockResolvedValue({ status: "failed", failed_set: 1, failed_index: 1, statements: 4,
      error: "constraint failed", rollback: "complete", sets: [{ index: 0, first_result: 0, result_count: 2, statements: 2, affected: 1 }] });
    await prompt();
    fireEvent.click(screen.getByRole("button", { name: "Batch sets" }));
    await screen.findByLabelText("Set 1 · value");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.click(screen.getByRole("button", { name: "Run 2 sets" }));
    expect(await screen.findByText(/Parameter set 2, statement 2 failed/)).toHaveTextContent("1 sets finished before the failure");
    expect(screen.getByText(/Parameter set 2, statement 2 failed/)).toHaveTextContent(/rolled back/);
  });
  it("rejects a changed connection generation during batch preparation", async () => {
    await prompt();
    inspect.mockResolvedValue({ names: ["value", "later"], generation: 8 });
    fireEvent.click(screen.getByRole("button", { name: "Batch sets" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The target connection changed");
    expect(screen.queryByLabelText("Set 1 · value")).not.toBeInTheDocument();
    expect(batch).not.toHaveBeenCalled();
  });
  it("expands names for later session modes while preserving NULL and empty values", async () => {
    await prompt();
    fireEvent.click(screen.getByLabelText("value · NULL"));
    inspect.mockResolvedValue({ names: ["value", "later"], generation: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Batch sets" }));
    await screen.findByLabelText("Set 1 · later");
    expect(screen.getByLabelText("Set 1 · value · NULL")).toBeChecked();
    expect(screen.getByLabelText("Set 1 · later")).toHaveValue("");
    expect(screen.getByLabelText("Set 1 · later · NULL")).not.toBeChecked();
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(batch).not.toHaveBeenCalled();
  });
});
