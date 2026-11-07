import { beforeEach, describe, expect, it } from "vitest";
import { useWorkspace } from "./workspace";

function resetWorkspace() {
  useWorkspace.setState({
    tabs: [{ id: "welcome", kind: "welcome", title: "Welcome" }],
    activeTabId: "welcome",
  });
}

describe("useWorkspace store", () => {
  beforeEach(() => {
    resetWorkspace();
  });

  it("has a welcome tab active by default", () => {
    const s = useWorkspace.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].id).toBe("welcome");
    expect(s.tabs[0].kind).toBe("welcome");
    expect(s.activeTabId).toBe("welcome");
  });

  it("openTab switches active without duplicating when id already exists", () => {
    useWorkspace.getState().openTab({
      id: "welcome",
      kind: "welcome",
      title: "Welcome Again",
    });
    const s = useWorkspace.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe("welcome");
  });

  it("openTab pushes a new tab and activates it", () => {
    const qTab = {
      id: "q1",
      kind: "query" as const,
      title: "Query 1",
    };
    useWorkspace.getState().openTab(qTab);
    const s = useWorkspace.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.tabs[1]).toEqual(qTab);
    expect(s.activeTabId).toBe("q1");
  });

  it("closeTab on current active moves active to previous tab", () => {
    const ws = useWorkspace.getState();
    ws.openTab({ id: "q1", kind: "query", title: "Q1" });
    ws.openTab({ id: "q2", kind: "query", title: "Q2" });
    // active now q2, tabs: [welcome, q1, q2]
    useWorkspace.getState().closeTab("q2");
    const s = useWorkspace.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["welcome", "q1"]);
    expect(s.activeTabId).toBe("q1");
  });

  it("closeTab on the final tab sets activeTabId to null", () => {
    useWorkspace.getState().closeTab("welcome");
    const s = useWorkspace.getState();
    expect(s.tabs).toHaveLength(0);
    expect(s.activeTabId).toBeNull();
  });

  it("closeTab on a non-active tab keeps current active", () => {
    const ws = useWorkspace.getState();
    ws.openTab({ id: "q1", kind: "query", title: "Q1" });
    ws.openTab({ id: "q2", kind: "query", title: "Q2" });
    // active: q2
    useWorkspace.getState().closeTab("q1");
    const s = useWorkspace.getState();
    expect(s.tabs.map((t) => t.id)).toEqual(["welcome", "q2"]);
    expect(s.activeTabId).toBe("q2");
  });

  it("setActive switches active tab", () => {
    useWorkspace.getState().openTab({ id: "q1", kind: "query", title: "Q1" });
    useWorkspace.getState().setActive("welcome");
    expect(useWorkspace.getState().activeTabId).toBe("welcome");
  });
});

describe("plan runtime persistence and closing", () => {
  it("does not persist execution intent, source identity, result values or running state", () => {
    useWorkspace.setState({ tabs: [{ id: "explain:p", kind: "explain", title: "Plan", connectionId: "c", sourceQueryId: "query:q", sourceSessionIdentity: "runtime-session", explainRequested: true, explainRunning: true, transactionOpen: true, explainSnapshot: { connectionId: "c", sql: "SELECT :secret", analyze: true, roots: [{ id: "p", label: "sensitive-result", children: [] }] } }] });
    const stored = localStorage.getItem("rdb:workspace")!;
    expect(stored).not.toMatch(/runtime-session|sensitive-result|explainSnapshot|explainRequested|explainRunning|transactionOpen/);
    expect(JSON.parse(stored).state.tabs[0].sourceQueryId).toBe("query:q");
  });
  it("discards runtime fields supplied by old or edited persisted state", async () => {
    localStorage.setItem("rdb:workspace", JSON.stringify({ version: 0, state: { tabs: [{ id: "explain:p", kind: "explain", title: "Plan", sourceSessionIdentity: "old", explainRequested: true, explainRunning: true, transactionOpen: true, explainSnapshot: { roots: [] } }], activeTabId: "explain:p" } }));
    await useWorkspace.persist.rehydrate();
    expect(useWorkspace.getState().tabs[0]).toEqual({ id: "explain:p", kind: "explain", title: "Plan" });
  });
  it("asks before closing a running plan but closes an idle plan immediately", () => {
    useWorkspace.setState({ tabs: [{ id: "explain:p", kind: "explain", title: "Plan", explainRunning: true }], activeTabId: "explain:p", pendingClose: null });
    useWorkspace.getState().closeTab("explain:p");
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(useWorkspace.getState().pendingClose).not.toBeNull();
    useWorkspace.getState().cancelClose();
    useWorkspace.setState({ tabs: [{ id: "explain:p", kind: "explain", title: "Plan", explainRunning: false }] });
    useWorkspace.getState().closeTab("explain:p");
    expect(useWorkspace.getState().tabs).toHaveLength(0);
  });
});
