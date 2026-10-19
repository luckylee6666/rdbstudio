import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it } from "vitest";
import { SyncView } from "./SyncView";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import type { ConnectionConfig } from "@/types";

const source: ConnectionConfig = { id: "src", name: "Source", driver: "sqlite", file_path: "/tmp/src.db" };
const target: ConnectionConfig = { id: "dst", name: "Target", driver: "postgres", host: "localhost", username: "tester" };

const basePreview = {
  token: "review-token",
  source_driver: "sqlite" as const,
  target_driver: "postgres" as const,
  structure: {
    source_table: "users",
    target_table: "users_copy",
    target_exists: false,
    changes: [{ name: "id", source_type: "INTEGER", target_type: "BIGINT", kind: "create_column", supported: true }],
    statements: ['CREATE TABLE "users_copy" ("id" BIGINT PRIMARY KEY)'],
    supported: true,
    ddl_transactional: true,
  },
  data_supported: true,
  data_reason: null,
  counts: { inserts: 2, updates: 1, deletes: 1, unchanged: 0, sample_conflict_keys: ["[1]"] },
  rows_examined: 4,
  bytes_examined: 128,
};

function setup() {
  const commands: string[] = [];
  mockIPC((command) => {
    commands.push(command);
    if (command === "list_tables") return [{ name: "users", kind: "table" }];
    if (command === "preview_sync") return basePreview;
    if (command === "apply_data_sync") {
      return { inserted: 2, updated: 1, deleted: 1, structure_statements: 1, structure_applied_before_data: true, transactional: false };
    }
    return undefined;
  });
  render(<SyncView />);
  return commands;
}

describe("SyncView review and confirmation flow", () => {
  beforeEach(() => {
    clearMocks();
    useI18n.setState({ lang: "en" });
    useConnections.setState({
      list: [source, target],
      loaded: true,
      listError: null,
      status: { src: "connected", dst: "connected" },
      versions: {},
      branches: {},
      errors: {},
      treeFilter: "",
    });
  });

  it("previews differences, requires an explicit mirror confirmation, then applies", async () => {
    const calls = setup();
    await waitFor(() => expect(screen.getAllByRole("option", { name: "users" }).length).toBeGreaterThan(0));
    fireEvent.change(screen.getByLabelText("Source table"), { target: { value: "users" } });
    fireEvent.change(screen.getByLabelText("Target table"), { target: { value: "\u0000custom" } });
    fireEvent.change(screen.getByLabelText("New target table name"), { target: { value: "users_copy" } });
    fireEvent.click(screen.getByLabelText(/Include target-only rows/));
    fireEvent.click(screen.getByRole("button", { name: "Preview differences" }));

    await screen.findByText("To insert");
    expect(screen.getByText("new table")).toBeInTheDocument();
    expect(screen.getByText('CREATE TABLE "users_copy" ("id" BIGINT PRIMARY KEY)')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Conflict handling"), { target: { value: "mirror" } });
    fireEvent.click(screen.getByLabelText("Create a missing target table and transfer data"));
    fireEvent.click(screen.getByRole("button", { name: "Confirm and apply data sync" }));
    expect(calls).not.toContain("apply_data_sync");

    const confirmButtons = screen.getAllByRole("button", { name: "Confirm and apply data sync" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(calls).toContain("apply_data_sync"));
    expect(screen.getByText(/Structure was applied first/)).toBeInTheDocument();
  });
});
