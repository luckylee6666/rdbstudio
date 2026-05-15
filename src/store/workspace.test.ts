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
