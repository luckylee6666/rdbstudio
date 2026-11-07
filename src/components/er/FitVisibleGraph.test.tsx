import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FitVisibleGraph } from "./FitVisibleGraph";

const graph = vi.hoisted(() => ({ fit: vi.fn(), initialized: true, viewport: true }));
vi.mock("@xyflow/react", () => ({
  useNodesInitialized: () => graph.initialized,
  useReactFlow: () => ({ fitView: graph.fit, viewportInitialized: graph.viewport }),
}));
let resize: () => void;
let width: number;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const container = { current: document.createElement("div") };

beforeEach(() => {
  graph.fit.mockReset().mockResolvedValue(true);
  graph.initialized = true; graph.viewport = true; width = 0; frames.clear();
  vi.spyOn(container.current, "getBoundingClientRect").mockImplementation(() => ({ width, height: width, x: 0, y: 0, top: 0, left: 0, right: width, bottom: width, toJSON() {} }));
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} disconnect() {}
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function frame() {
  await act(async () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)); });
}

it("waits for a visible canvas, then preserves the viewport on tab switches", async () => {
  const revision = {};
  const view = render(<FitVisibleGraph active={false} container={container} revision={revision} />);
  await frame(); expect(graph.fit).not.toHaveBeenCalled();
  view.rerender(<FitVisibleGraph active container={container} revision={revision} />);
  await frame(); expect(graph.fit).not.toHaveBeenCalled();
  width = 800; act(() => resize()); await frame(); expect(graph.fit).toHaveBeenCalledOnce();
  view.rerender(<FitVisibleGraph active={false} container={container} revision={revision} />);
  view.rerender(<FitVisibleGraph active container={container} revision={revision} />);
  act(() => resize()); await frame(); expect(graph.fit).toHaveBeenCalledOnce();
  view.rerender(<FitVisibleGraph active container={container} revision={{}} />);
  await frame(); expect(graph.fit).toHaveBeenCalledTimes(2);
});

it("cancels a scheduled fit on hide and waits for measured nodes", async () => {
  graph.initialized = false; width = 800;
  const revision = {};
  const view = render(<FitVisibleGraph active container={container} revision={revision} />);
  await frame(); expect(graph.fit).not.toHaveBeenCalled();
  graph.initialized = true;
  view.rerender(<FitVisibleGraph active container={container} revision={revision} />);
  view.rerender(<FitVisibleGraph active={false} container={container} revision={revision} />);
  await frame(); expect(graph.fit).not.toHaveBeenCalled();
  view.rerender(<FitVisibleGraph active container={container} revision={revision} />);
  await frame(); expect(graph.fit).toHaveBeenCalledOnce();
});
