import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplainView } from "./ExplainView";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import type { WorkspaceTab } from "@/types";
import type { Node, NodeChange } from "@xyflow/react";

const flow = vi.hoisted(() => ({ props: null as unknown as {
  nodes: Node[]; onNodesChange: (changes: NodeChange[]) => void; deleteKeyCode: unknown;
} }));

vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@xyflow/react", async (original) => ({
  ...await original<typeof import("@xyflow/react")>(),
  ReactFlow: (props: typeof flow.props) => { flow.props = props; return <div data-testid="plan">{JSON.stringify(props.nodes)}</div>; },
  Background: () => null, Controls: () => null, Handle: () => null,
  BackgroundVariant: { Dots: "dots" }, Position: { Top: "top", Bottom: "bottom" },
}));

describe("parameterized visual explain", () => {
  const tab: WorkspaceTab = { id: "explain:test", title: "Explain", kind: "explain", connectionId: "c", sourceQueryId: "query:source", sourceSessionIdentity: "session-1", sql: "SELECT * FROM saved WHERE id=:id" };
  const execute = vi.fn();
  const cancel = vi.fn();
  const inspect = vi.fn();
  const attach = vi.fn();
  const plainExecute = vi.fn();
  const plan = { columns: [], rows: [[2, 0, 0, "SEARCH saved USING INTEGER PRIMARY KEY (rowid=?)"]], elapsed_ms: 0, truncated: false };
  beforeEach(() => {
    localStorage.clear(); clearMocks(); execute.mockReset(); cancel.mockReset(); inspect.mockReset(); attach.mockReset(); plainExecute.mockReset();
    useI18n.setState({ lang: "en" });
    useWorkspace.setState({ tabs: [tab, { id: "query:source", title: "Source", kind: "query", connectionId: "c" }], activeTabId: tab.id });
    useConnections.setState({ list: [{ id: "c", name: "Test database", driver: "sqlite", group: null, ssl_mode: "disable" }], status: { c: "connected" } });
    attach.mockResolvedValue(undefined);
    plainExecute.mockResolvedValue(plan);
    inspect.mockResolvedValue({ names: ["id"], generation: 3 });
    execute.mockResolvedValue({ status: "ok", result: plan, results: [plan], statements: 1, total_affected: 0 });
    mockIPC((command, payload) => {
      if (command === "attach_editor_plan") return attach(payload);
      if (command === "query_parameter_names") return inspect(payload);
      if (command === "execute_parameter_query") return execute(payload);
      if (command === "cancel_query") { cancel(payload); return true; }
      if (command === "execute_query") return plainExecute(payload);
      return undefined;
    });
  });
  afterEach(clearMocks);
  it("preserves measured dimensions and selection when a plan node moves", async () => {
    inspect.mockResolvedValue({ names: [], generation: 3 });
    render(<ExplainView tab={tab} />);
    await waitFor(() => expect(screen.getByTestId("plan")).toHaveTextContent("SEARCH saved"));
    const id = flow.props.nodes[0].id;
    act(() => flow.props.onNodesChange([
      { id, type: "dimensions", dimensions: { width: 260, height: 110 } },
      { id, type: "select", selected: true },
      { id, type: "position", position: { x: 200, y: 140 } },
    ]));
    expect(flow.props.nodes[0]).toMatchObject({ measured: { width: 260, height: 110 }, selected: true, position: { x: 200, y: 140 } });
    expect(flow.props.deleteKeyCode).toBeNull();
    expect(plainExecute).toHaveBeenCalledOnce();
  });
  it("requests typed values and renders the native EXPLAIN result", async () => {
    render(<ExplainView tab={tab} />);
    await screen.findByRole("dialog", { name: "Query parameters" });
    expect(execute).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledWith({ id: "c", sourceSessionId: "query:source", planSessionId: tab.id, sourceIdentity: "session-1" });
    expect(attach.mock.invocationCallOrder[0]).toBeLessThan(inspect.mock.invocationCallOrder[0]);
    fireEvent.change(screen.getByLabelText("id · Type"), { target: { value: "integer" } });
    fireEvent.change(screen.getByLabelText("id · Value"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Run with parameters" }));
    await waitFor(() => expect(screen.getByTestId("plan")).toHaveTextContent("SEARCH saved"));
    expect(execute).toHaveBeenCalledWith({ id: "c", request: expect.objectContaining({ sqls: ["EXPLAIN QUERY PLAN SELECT * FROM saved WHERE id=:id"], parameters: [{ name: "id", kind: "integer", value: "42" }], generation: 3, sessionId: tab.id }) });
    expect(useWorkspace.getState().tabs[0].queryParameterDefaults).toEqual([{ name: "id", kind: "integer" }]);
  });
  it("does not execute when parameter entry is cancelled", async () => {
    render(<ExplainView tab={tab} />);
    await screen.findByRole("dialog", { name: "Query parameters" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(execute).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("ignores old parameter analysis after the SQL template changes", async () => {
    let resolve!: (value: unknown) => void;
    inspect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const view = render(<ExplainView tab={tab} />);
    await waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    inspect.mockResolvedValue({ names: ["new_id"], generation: 4 });
    view.rerender(<ExplainView tab={{ ...tab, sql: "SELECT * FROM saved WHERE id=:new_id" }} />);
    await screen.findByLabelText("new_id · Value");
    await act(async () => { resolve({ names: ["old_id"], generation: 3 }); });
    expect(screen.queryByLabelText("old_id · Value")).not.toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("new_id · Value"), { target: { value: "42" } });
    fireEvent.click(screen.getByRole("button", { name: "Run with parameters" }));
    await waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(execute.mock.calls[0][0].request).toMatchObject({ generation: 4, sqls: ["EXPLAIN QUERY PLAN SELECT * FROM saved WHERE id=:new_id"] });
  });
  it("cancels an outstanding inspector when the plan tab is unmounted", async () => {
    let resolve!: (value: unknown) => void;
    inspect.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = render(<ExplainView tab={tab} />);
    await waitFor(() => expect(inspect).toHaveBeenCalledOnce());
    const queryId = inspect.mock.calls[0][0].queryId;
    view.unmount();
    expect(cancel).toHaveBeenCalledWith({ queryId });
    await act(async () => { resolve({ names: ["id"], generation: 3 }); });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(execute).not.toHaveBeenCalled();
  });
  function setupAnalyze(sql = "SELECT 1", requested = true) {
    const analyzeTab: WorkspaceTab = { ...tab, id: "explain-analyze:test", sql, explainRequested: requested };
    useWorkspace.setState(state => ({ tabs: [analyzeTab, ...state.tabs.filter(item => item.kind === "query")], activeTabId: analyzeTab.id }));
    useConnections.setState({ list: [{ id: "c", name: "Postgres", driver: "postgres", group: null, ssl_mode: "disable" }] });
    plainExecute.mockResolvedValue({ ...plan, rows: [[[{ Plan: { "Node Type": "Result", "Total Cost": 1, "Plan Rows": 1 } }]]] });
    return analyzeTab;
  }
  it("executes explicit Analyze once under StrictMode and reuses the runtime plan after remount", async () => {
    const analyzeTab = setupAnalyze();
    const view = render(<StrictMode><ExplainView tab={analyzeTab} /></StrictMode>);
    await screen.findByTestId("plan");
    expect(plainExecute).toHaveBeenCalledOnce();
    expect(useWorkspace.getState().tabs[0].explainRequested).toBe(false);
    view.unmount();
    render(<StrictMode><ExplainView tab={useWorkspace.getState().tabs[0]} /></StrictMode>);
    await screen.findByTestId("plan");
    expect(plainExecute).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledOnce();
  });
  it("requires explicit execution of restored Analyze and confirmation on every write rerun", async () => {
    const analyzeTab = setupAnalyze("DELETE FROM saved", false);
    render(<ExplainView tab={analyzeTab} />);
    await screen.findByText(/execute explicitly/i);
    expect(plainExecute).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Run Analyze" })[0]);
    await screen.findByText("Run this statement for real?");
    expect(plainExecute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Run anyway" }));
    await screen.findByTestId("plan");
    expect(plainExecute).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Run Analyze" }));
    await screen.findByText("Run this statement for real?");
    expect(plainExecute).toHaveBeenCalledOnce();
  });
  it("does not recreate a closed or reset source", async () => {
    attach.mockRejectedValue(new Error("source query session changed or closed"));
    render(<ExplainView tab={tab} />);
    await screen.findByText(/source query session changed/);
    expect(inspect).not.toHaveBeenCalled();
    expect(plainExecute).not.toHaveBeenCalled();
  });
  it("does not attach a restored plan with no runtime source identity", async () => {
    render(<ExplainView tab={{ ...tab, sourceSessionIdentity: undefined }} />);
    await screen.findByText(/source query session is unavailable/);
    expect(attach).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
  it("does not execute after closure while attachment is in flight", async () => {
    let resolve!: () => void;
    attach.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const view = render(<ExplainView tab={tab} />);
    await waitFor(() => expect(attach).toHaveBeenCalledOnce());
    act(() => useWorkspace.setState({ tabs: [], activeTabId: null }));
    view.unmount();
    await act(async () => { resolve(); });
    expect(inspect).not.toHaveBeenCalled();
    expect(plainExecute).not.toHaveBeenCalled();
  });

});
