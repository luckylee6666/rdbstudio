import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PromptDialog } from "./PromptDialog";

describe("PromptDialog", () => {
  it("keeps the dialog open and shows an asynchronous submit error", async () => {
    const onClose = vi.fn();
    render(
      <PromptDialog
        open
        title="Rename table"
        initialValue="users"
        submitLabel="Save"
        onSubmit={async () => {
          throw new Error("table already exists");
        }}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "table already exists"
    );
    expect(screen.getByRole("dialog", { name: "Rename table" })).toBeInTheDocument();
    await waitFor(() => expect(onClose).not.toHaveBeenCalled());
  });
});
