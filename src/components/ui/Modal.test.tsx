import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anyModalOpen, Modal } from "./Modal";
import { useI18n } from "@/store/i18n";

function frame() { act(() => { vi.advanceTimersByTime(32); }); }

function NestedModals() {
  const [parentOpen, setParentOpen] = useState(true);
  const [childOpen, setChildOpen] = useState(false);
  return (
    <>
      <Modal
        open={parentOpen}
        onClose={() => setParentOpen(false)}
        title="Parent"
      >
        <button onClick={() => setChildOpen(true)}>Open child</button>
        <Modal
          open={childOpen}
          onClose={() => setChildOpen(false)}
          title="Child"
        >
          <button>Child action</button>
        </Modal>
      </Modal>
    </>
  );
}

describe("Modal keyboard ownership", () => {
  beforeEach(() => {
    useI18n.setState({ lang: "en" });
    vi.useFakeTimers();
    // jsdom has no layout; model visible controls while exercising real focus.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{}] as unknown as DOMRectList);
  });
  afterEach(() => {
    cleanup();
    frame();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("focuses the first control without moving focus back to the container", () => {
    render(<Modal open title="Initial focus" onClose={vi.fn()}><input aria-label="Name" /></Modal>);
    frame();
    expect(screen.getByRole("button", { name: "Close: Initial focus" })).toHaveFocus();
    expect(anyModalOpen()).toBe(true);
  });

  it("keeps explicit child autofocus and ignores handled Escape or IME Escape", () => {
    const onClose = vi.fn();
    render(<Modal open title="Editor" onClose={onClose}>
      <input aria-label="Name" autoFocus onKeyDown={(event) => { if (event.key === "Escape") event.preventDefault(); }} />
    </Modal>);
    frame();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("wraps Tab in both directions and recovers from outside or container focus", () => {
    render(<><button>Outside</button><Modal open title="Focus trap" onClose={vi.fn()}>
      <input aria-label="Name" /><button>Last action</button>
      <button disabled tabIndex={0}>Disabled action</button>
      <button hidden>Hidden action</button><button style={{ visibility: "hidden" }}>Invisible action</button>
    </Modal></>);
    frame();
    const first = screen.getByRole("button", { name: "Close: Focus trap" });
    const last = screen.getByRole("button", { name: "Last action" });
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(first).toHaveFocus();
    screen.getByRole("button", { name: "Outside" }).focus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    screen.getByRole("dialog").focus();
    fireEvent.keyDown(window, { key: "Tab" });
    expect(first).toHaveFocus();
  });

  it("retains focus when a busy dialog has no enabled controls", () => {
    render(<Modal open closeDisabled title="Busy" onClose={vi.fn()}><button disabled>Saving</button></Modal>);
    frame();
    expect(screen.getByRole("dialog")).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("restores the parent opener after closing a nested modal", () => {
    render(<NestedModals />);
    frame();
    const opener = screen.getByRole("button", { name: "Open child" });
    opener.focus();
    fireEvent.click(opener);
    frame();
    expect(within(screen.getByRole("dialog", { name: "Child" })).getByRole("button", { name: "Close: Child" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    frame();
    expect(opener).toHaveFocus();
    expect(anyModalOpen()).toBe(true);
  });

  it("restores the original opener if parent and child are removed together", () => {
    function Flow() {
      const [open, setOpen] = useState(false);
      const [child, setChild] = useState(false);
      return <><button onClick={() => setOpen(true)}>Launch</button>{open && <Modal open title="Parent" onClose={() => setOpen(false)}>
        <button onClick={() => setChild(true)}>Open child</button>
        <Modal open={child} title="Child" onClose={() => setChild(false)}><button onClick={() => setOpen(false)}>Finish both</button></Modal>
      </Modal>}</>;
    }
    render(<Flow />);
    const launch = screen.getByRole("button", { name: "Launch" });
    launch.focus(); fireEvent.click(launch); frame();
    const child = screen.getByRole("button", { name: "Open child" });
    child.focus(); fireEvent.click(child); frame();
    fireEvent.click(screen.getByRole("button", { name: "Finish both" })); frame();
    expect(launch).toHaveFocus();
    expect(anyModalOpen()).toBe(false);
  });

  it("does not restore focus outside a newly opened dialog", () => {
    const { rerender } = render(<><button>Outside</button><Modal open title="Old" onClose={vi.fn()}>Old contents</Modal></>);
    frame();
    rerender(<><button>Outside</button><Modal open={false} title="Old" onClose={vi.fn()}>Old contents</Modal>
      <Modal open title="New" onClose={vi.fn()}><input autoFocus aria-label="New name" /></Modal></>);
    frame();
    expect(screen.getByRole("textbox", { name: "New name" })).toHaveFocus();
  });

  it("localizes the default close button label", () => {
    useI18n.setState({ lang: "zh" });
    render(<Modal open title="复制表" onClose={vi.fn()}>内容</Modal>);
    expect(screen.getByRole("button", { name: "关闭: 复制表" })).toBeInTheDocument();
  });

  it("closes only the topmost nested modal on Escape", () => {
    render(<NestedModals />);
    fireEvent.click(screen.getByRole("button", { name: "Open child" }));
    expect(screen.getByRole("dialog", { name: "Child" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Child" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Parent" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Parent" })).not.toBeInTheDocument();
  });

  it("blocks every dismissal path while closing is disabled", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Modal open closeDisabled onClose={onClose} title="Working">
        Exporting
      </Modal>
    );

    const dialog = screen.getByRole("dialog", { name: "Working" });
    const backdrop = dialog.parentElement?.firstElementChild;
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close: Working" }));
    fireEvent.click(backdrop!);
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <Modal open onClose={onClose} title="Working">
        Done
      </Modal>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
