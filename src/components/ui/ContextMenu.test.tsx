import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

describe("ContextMenu", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not install stale global listeners after an immediate unmount", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { unmount } = render(
      <ContextMenu
        x={20}
        y={20}
        items={[{ id: "open", label: "Open" }]}
        onClose={onClose}
      />
    );

    unmount();
    vi.runAllTimers();
    fireEvent.mouseDown(window);
    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs a menu action once and closes the menu", () => {
    const onAction = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={20}
        y={20}
        items={[{ id: "open", label: "Open", onClick: onAction }]}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
