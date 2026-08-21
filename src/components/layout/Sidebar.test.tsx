import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/connection/ConnectionTree", () => ({
  ConnectionTree: () => <div>Connections</div>,
}));
vi.mock("@/components/layout/HistoryPanel", () => ({ HistoryPanel: () => null }));
vi.mock("@/components/layout/FavoritesPanel", () => ({ FavoritesPanel: () => null }));
vi.mock("@/components/layout/QueriesPanel", () => ({ QueriesPanel: () => null }));
vi.mock("@/components/layout/ModelsPanel", () => ({ ModelsPanel: () => null }));
vi.mock("@/components/layout/SnippetsPanel", () => ({ SnippetsPanel: () => null }));

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  Sidebar,
  clampSidebarWidth,
} from "./Sidebar";

describe("Sidebar resizing", () => {
  beforeEach(() => localStorage.clear());

  it("clamps invalid and out-of-range widths", () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(clampSidebarWidth(100)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(900)).toBe(SIDEBAR_MAX_WIDTH);
  });

  it("restores the saved width and supports keyboard resizing", () => {
    localStorage.setItem("rdb:sidebarWidth", "400");
    const { container } = render(<Sidebar />);
    const aside = container.querySelector("aside");
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    expect(aside).toHaveStyle({ width: "400px" });
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(aside).toHaveStyle({ width: "416px" });
    expect(localStorage.getItem("rdb:sidebarWidth")).toBe("416");

    fireEvent.doubleClick(separator);
    expect(aside).toHaveStyle({ width: `${SIDEBAR_DEFAULT_WIDTH}px` });
  });

  it("resizes by dragging the divider and persists on release", () => {
    const { container } = render(<Sidebar />);
    const aside = container.querySelector("aside");
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 1, clientX: 280 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 420 });
    fireEvent.pointerUp(separator, { pointerId: 1, clientX: 420 });

    expect(aside).toHaveStyle({ width: "420px" });
    expect(localStorage.getItem("rdb:sidebarWidth")).toBe("420");
  });

  it("finishes an interrupted resize when the window loses focus", () => {
    const { container } = render(<Sidebar />);
    const aside = container.querySelector("aside");
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 2, clientX: 280 });
    fireEvent.pointerMove(separator, { pointerId: 2, clientX: 480 });
    expect(aside).toHaveStyle({ width: "480px" });
    expect(document.body.style.cursor).toBe("col-resize");

    fireEvent.blur(window);

    expect(localStorage.getItem("rdb:sidebarWidth")).toBe("480");
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
  });

  it("clamps live pointer resizing before committing it", () => {
    const { container } = render(<Sidebar />);
    const aside = container.querySelector("aside");
    const separator = screen.getByRole("separator", { name: "Resize sidebar" });

    fireEvent.pointerDown(separator, { button: 0, pointerId: 3, clientX: 280 });
    fireEvent.pointerMove(separator, { pointerId: 3, clientX: 2_000 });
    fireEvent.pointerCancel(separator, { pointerId: 3 });

    expect(aside).toHaveStyle({ width: `${SIDEBAR_MAX_WIDTH}px` });
    expect(localStorage.getItem("rdb:sidebarWidth")).toBe(
      String(SIDEBAR_MAX_WIDTH)
    );
  });
});
