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

  it.each(["Enter", " "])("navigates enabled items and activates once using %s", (key) => {
    vi.useFakeTimers();
    const action = vi.fn();
    const close = vi.fn();
    render(<ContextMenu x={20} y={20} onClose={close} items={[
      { id: "first", label: "First" },
      { id: "disabled", label: "Disabled", disabled: true },
      { id: "sep", label: "", separator: true },
      { id: "last", label: "Last", onClick: action },
    ]} />);
    vi.runAllTimers();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    fireEvent.keyDown(document.activeElement!, { key, repeat: true });
    expect(action).not.toHaveBeenCalled();
    fireEvent.keyDown(document.activeElement!, { key });
    expect(action).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener on Escape", () => {
    vi.useFakeTimers();
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    const close = vi.fn();
    const { unmount } = render(<ContextMenu x={20} y={20} onClose={close} items={[{ id: "item", label: "Item" }]} />);
    vi.runAllTimers();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("handles Escape before an enclosing dialog shortcut", () => {
    vi.useFakeTimers();
    const dialogKey = vi.fn();
    window.addEventListener("keydown", dialogKey);
    const close = vi.fn();
    const { unmount } = render(<ContextMenu x={20} y={20} onClose={close} items={[{ id: "item", label: "Item" }]} />);
    vi.runAllTimers();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);
    expect(dialogKey).not.toHaveBeenCalled();
    unmount();
    window.removeEventListener("keydown", dialogKey);
  });

  it("keeps long menus inside the viewport and scrollable", () => {
    render(<ContextMenu x={-20} y={-20} onClose={() => undefined}
      items={Array.from({ length: 80 }, (_, index) => ({ id: String(index), label: String(index) }))} />);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe("8px");
    expect(menu.style.top).toBe("8px");
    expect(menu.style.maxHeight).toBe(`${window.innerHeight - 16}px`);
    expect(menu).toHaveClass("overflow-y-auto");
  });
});
