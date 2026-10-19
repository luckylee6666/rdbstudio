import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { useWorkspace } from "@/store/workspace";

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
vi.mock("./ExplainView", () => ({ ExplainView: () => <div>Explain</div> }));
vi.mock("./RedisKeyView", () => ({ RedisKeyView: () => <div>Redis</div> }));

describe("WorkspaceTabs view identity", () => {
  beforeEach(() => {
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

  it("remounts same-kind views when the active tab changes", () => {
    render(<WorkspaceTabs />);
    expect(screen.getByTestId("table-view-identity")).toHaveTextContent(
      "data:c1:main:a/data:c1:main:a"
    );

    act(() => useWorkspace.getState().setActive("data:c1:main:b"));

    expect(screen.getByTestId("table-view-identity")).toHaveTextContent(
      "data:c1:main:b/data:c1:main:b"
    );
  });

  it("keeps inactive query tabs mounted and closes their editor session with the tab", () => {
    useWorkspace.setState({
      tabs: [
        { id: "q1", kind: "query", title: "Query 1" },
        { id: "q2", kind: "query", title: "Query 2" },
      ],
      activeTabId: "q1",
    });
    const view = render(<WorkspaceTabs />);
    expect(queryLifecycle.mounted.mock.calls.map(([id]) => id).sort()).toEqual(["q1", "q2"]);
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
});
