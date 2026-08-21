import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Modal } from "./Modal";

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
