import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { SnippetsPanel } from "./SnippetsPanel";
import type { Snippet } from "@/types";

const mockSnippets: Snippet[] = [
  {
    id: "1",
    name: "Get Users",
    sql: "SELECT * FROM users;",
    description: "Fetches all users",
  },
  {
    id: "2",
    name: "Count Orders",
    sql: "SELECT COUNT(*) FROM orders;",
    description: "Counts all completed orders",
  },
];

afterEach(() => {
  clearMocks();
});

describe("SnippetsPanel Component", () => {
  it("loads and renders snippets on mount", async () => {
    mockIPC((cmd) => {
      if (cmd === "list_snippets") {
        return mockSnippets;
      }
      return undefined;
    });

    render(<SnippetsPanel />);

    // Wait for snippets to load and render
    await waitFor(() => {
      expect(screen.getByText("Get Users")).toBeInTheDocument();
      expect(screen.getByText("Count Orders")).toBeInTheDocument();
    });

    expect(screen.getByText("SELECT * FROM users;")).toBeInTheDocument();
    expect(screen.getByText("Counts all completed orders")).toBeInTheDocument();
  });

  it("filters snippets based on search input", async () => {
    mockIPC((cmd) => {
      if (cmd === "list_snippets") return mockSnippets;
      return undefined;
    });

    render(<SnippetsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Get Users")).toBeInTheDocument();
    });

    const searchInput = screen.getByPlaceholderText(/search/i);
    
    // Search for "orders"
    fireEvent.change(searchInput, { target: { value: "orders" } });

    expect(screen.queryByText("Get Users")).not.toBeInTheDocument();
    expect(screen.getByText("Count Orders")).toBeInTheDocument();
  });

  it("opens modal, validates input, and saves new snippet", async () => {
    let savedSnippet: Snippet | null = null;
    mockIPC((cmd, payload) => {
      if (cmd === "list_snippets") return mockSnippets;
      if (cmd === "save_snippet") {
        savedSnippet = (payload as { snippet: Snippet }).snippet;
        return { ...savedSnippet, id: "3" };
      }
      return undefined;
    });

    render(<SnippetsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Get Users")).toBeInTheDocument();
    });

    // Click the New button
    const newButton = screen.getByTitle(/new/i);
    fireEvent.click(newButton);

    // Assert modal is open
    expect(screen.getByText(/new snippet/i)).toBeInTheDocument();

    // Click save without entering data to trigger validation
    const saveButton = screen.getByText(/save/i);
    fireEvent.click(saveButton);
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();

    // Fill in name and SQL
    const nameInput = screen.getByPlaceholderText("e.g. Find users by email");
    const sqlInput = screen.getByPlaceholderText("SELECT * FROM users WHERE email = 'test@example.com';");

    fireEvent.change(nameInput, { target: { value: "New Query" } });
    fireEvent.change(sqlInput, { target: { value: "SELECT 1;" } });

    // Save
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(savedSnippet).not.toBeNull();
    });

    expect(savedSnippet!.name).toBe("New Query");
    expect(savedSnippet!.sql).toBe("SELECT 1;");
  });

  it("deletes a snippet", async () => {
    let deletedId: string | null = null;
    mockIPC((cmd, payload) => {
      if (cmd === "list_snippets") return mockSnippets;
      if (cmd === "delete_snippet") {
        deletedId = (payload as { id: string }).id;
        return true;
      }
      return undefined;
    });

    render(<SnippetsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Get Users")).toBeInTheDocument();
    });

    // Click delete button for first snippet
    const deleteButtons = screen.getAllByTitle("Delete");
    fireEvent.click(deleteButtons[0]);

    // Expect confirmation modal
    expect(screen.getByText("Are you sure you want to delete this snippet?")).toBeInTheDocument();

    // Click delete in confirmation modal
    // Find the confirmation button which has the bg-danger class
    const confirmButton = screen.getAllByRole("button", { name: "Delete" }).find(
      (btn) => btn.classList.contains("bg-danger")
    );
    if (!confirmButton) throw new Error("Could not find confirm delete button");
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(deletedId).toBe("1");
    });
  });
});
