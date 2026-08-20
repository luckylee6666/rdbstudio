import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
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
});
