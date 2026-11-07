import { act, render } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Node, NodeChange } from "@xyflow/react";
import type { TableDescription } from "@/types";
import { ERDiagram, loadErPositions } from "./ERDiagram";

const flow = vi.hoisted(() => ({ props: null as unknown as {
  nodes: Node[]; onNodesChange: (changes: NodeChange[]) => void; deleteKeyCode: unknown;
} }));
vi.mock("@/components/theme/ThemeProvider", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("@xyflow/react", async (original) => ({
  ...await original<typeof import("@xyflow/react")>(),
  ReactFlow: (props: typeof flow.props) => { flow.props = props; return null; },
}));

const tables: TableDescription[] = [{ name: "items", columns: [], primary_key: [], foreign_keys: [], indexes: [] }];
beforeEach(() => localStorage.clear());

it("retains node measurements and selection through drag and parent rerenders", () => {
  const changed = vi.fn();
  const view = render(<ERDiagram tables={tables} layoutKey="measure-test" onPositionsChange={changed} />);
  const id = flow.props.nodes[0].id;
  act(() => flow.props.onNodesChange([
    { id, type: "dimensions", dimensions: { width: 240, height: 80 } },
    { id, type: "select", selected: true },
  ]));
  act(() => flow.props.onNodesChange([{ id, type: "position", position: { x: 150, y: 90 }, dragging: true }]));
  view.rerender(<ERDiagram tables={tables} layoutKey="measure-test" onPositionsChange={changed} />);
  expect(flow.props.nodes[0]).toMatchObject({ measured: { width: 240, height: 80 }, selected: true, position: { x: 150, y: 90 } });
  expect(loadErPositions("measure-test")[id]).toEqual({ x: 150, y: 90 });
  expect(changed).toHaveBeenLastCalledWith({ [id]: { x: 150, y: 90 } });
  expect(flow.props.deleteKeyCode).toBeNull();
});

it("does not persist dimension or selection updates as layout changes", () => {
  const changed = vi.fn();
  render(<ERDiagram tables={tables} layoutKey="dimensions-only" onPositionsChange={changed} />);
  changed.mockClear();
  const id = flow.props.nodes[0].id;
  act(() => flow.props.onNodesChange([{ id, type: "dimensions", dimensions: { width: 240, height: 80 } }]));
  expect(changed).not.toHaveBeenCalled();
  expect(localStorage.getItem("rdb:erLayout:dimensions-only")).toBeNull();
});
