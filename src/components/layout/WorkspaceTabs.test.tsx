import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { useWorkspace } from "@/store/workspace";

const planLifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
const queryLifecycle = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));

vi.mock("./TableDataView", async () => {
  const React = await import("react");
  return {
    TableDataView: ({ tab }: { tab: { id: string } }) => {
      const [mountedFor] = React.useState(tab.id);
      return (
        <div data-testid="table-view-identity">
          {tab.id}/{mountedFor}
        </div>
      );
    },
  };
});

vi.mock("./Welcome", () => ({ Welcome: () => <div>Welcome</div> }));
vi.mock("./QueryEditorView", async () => {
  const React = await import("react");
  return {
    QueryEditorView: ({ tab }: { tab: { id: string } }) => {
      React.useEffect(() => {
        queryLifecycle.mounted(tab.id);
        return () => queryLifecycle.unmounted(tab.id);
      }, [tab.id]);
      return <div data-testid={`query-view-${tab.id}`}>Query {tab.id}</div>;
    },
  };
});
vi.mock("./DesignerView", () => ({ DesignerView: () => <div>Designer</div> }));
vi.mock("./ERView", () => ({ ERView: () => <div>ER</div> }));
vi.mock("./ExplainView", async () => {
  const React = await import("react");
  return { ExplainView: ({ tab }: { tab: { id: string } }) => {
    React.useEffect(() => { planLifecycle.mounted(tab.id); return () => planLifecycle.unmounted(tab.id); }, [tab.id]);
    return <div data-testid={`plan-view-${tab.id}`}>Explain</div>;
  } };
});
vi.mock("./RedisKeyView", () => ({ RedisKeyView: () => <div>Redis</div> }));

describe("WorkspaceTabs view identity", () => {
  beforeEach(() => {
    planLifecycle.mounted.mockClear();
    planLifecycle.unmounted.mockClear();
    queryLifecycle.mounted.mockClear();
    queryLifecycle.unmounted.mockClear();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    useWorkspace.setState({
      tabs: [
        {
          id: "data:c1:main:a",
          kind: "table-data",
          title: "a",
          connectionId: "c1",
          table: "a",
        },
        {
          id: "data:c1:main:b",
          kind: "table-data",
          title: "b",
          connectionId: "c1",
          table: "b",
        },
      ],
      activeTabId: "data:c1:main:a",
    });
  });

  it("remounts same-kind views when the active tab changes", async () => {
    render(<WorkspaceTabs />);
    expect(await screen.findByTestId("table-view-identity")).toHaveTextContent(
      "data:c1:main:a/data:c1:main:a"
    );

    act(() => useWorkspace.getState().setActive("data:c1:main:b"));

    expect(await screen.findByTestId("table-view-identity")).toHaveTextContent(
      "data:c1:main:b/data:c1:main:b"
    );
  });

  it("exposes a separate focusable close button without nested interactive controls", async () => {
    render(<WorkspaceTabs />);
    await screen.findByTestId("table-view-identity");
    const close = screen.getByRole("button", { name: "Close: a" });
    expect(close.tagName).toBe("BUTTON");
    expect(close.parentElement?.closest("button")).toBeNull();
    close.focus();
    expect(close).toHaveFocus();
    act(() => close.click());
    expect(useWorkspace.getState().activeTabId).toBe("data:c1:main:b");
    expect(screen.queryByRole("button", { name: "Close: a" })).not.toBeInTheDocument();
  });

  it("keeps inactive query tabs mounted and closes their editor session with the tab", async () => {
    useWorkspace.setState({
      tabs: [
        { id: "q1", kind: "query", title: "Query 1" },
        { id: "q2", kind: "query", title: "Query 2" },
      ],
      activeTabId: "q1",
    });
    const view = render(<WorkspaceTabs />);
    await waitFor(() => expect(queryLifecycle.mounted.mock.calls.map(([id]) => id).sort()).toEqual(["q1", "q2"]));
    expect(screen.getByTestId("query-view-q1").parentElement).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("query-view-q2").parentElement).toHaveAttribute("hidden");

    act(() => useWorkspace.getState().setActive("q2"));
    expect(queryLifecycle.unmounted).not.toHaveBeenCalled();
    expect(screen.getByTestId("query-view-q1").parentElement).toHaveAttribute("hidden");
    expect(screen.getByTestId("query-view-q2").parentElement).not.toHaveAttribute("hidden");

    act(() => useWorkspace.getState().closeTab("q1"));
    expect(queryLifecycle.unmounted).toHaveBeenCalledWith("q1");
    view.unmount();
  });
  it("keeps plans mounted when switching tabs so Analyze is not cancelled or repeated", async () => {
    useWorkspace.setState({ tabs: [{ id: "p", kind: "explain", title: "Plan" }, { id: "q", kind: "query", title: "Query" }], activeTabId: "p" });
    render(<WorkspaceTabs />);
    await waitFor(() => expect(planLifecycle.mounted).toHaveBeenCalledOnce());
    await screen.findByTestId("query-view-q");
    act(() => useWorkspace.getState().setActive("q"));
    expect(planLifecycle.unmounted).not.toHaveBeenCalled();
    expect(screen.getByTestId("plan-view-p").parentElement).toHaveAttribute("hidden");
    act(() => useWorkspace.getState().setActive("p"));
    expect(planLifecycle.mounted).toHaveBeenCalledOnce();
    act(() => useWorkspace.getState().closeTab("p", true));
    expect(planLifecycle.unmounted).toHaveBeenCalledOnce();
  });

});
