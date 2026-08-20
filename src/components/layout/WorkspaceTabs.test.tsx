import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "./WorkspaceTabs";
import { useWorkspace } from "@/store/workspace";

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
vi.mock("./QueryEditorView", () => ({ QueryEditorView: () => <div>Query</div> }));
vi.mock("./DesignerView", () => ({ DesignerView: () => <div>Designer</div> }));
vi.mock("./ERView", () => ({ ERView: () => <div>ER</div> }));
vi.mock("./ExplainView", () => ({ ExplainView: () => <div>Explain</div> }));
vi.mock("./RedisKeyView", () => ({ RedisKeyView: () => <div>Redis</div> }));

describe("WorkspaceTabs view identity", () => {
  beforeEach(() => {
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
});
