import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { beforeEach, describe, expect, it } from "vitest";
import { GlobalSearchView } from "./GlobalSearchView";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import type { ConnectionConfig } from "@/types";

const config: ConnectionConfig = {
  id: "local",
  name: "Local",
  driver: "sqlite",
  file_path: "/tmp/search.db",
};

describe("GlobalSearchView", () => {
  beforeEach(() => {
    clearMocks();
    useI18n.setState({ lang: "en" });
    useConnections.setState({
      list: [config],
      loaded: true,
      listError: null,
      status: { local: "connected" },
      versions: {},
      branches: {},
      errors: {},
      treeFilter: "",
    });
    useWorkspace.setState({ tabs: [], activeTabId: null });
    mockIPC((command) => {
      if (command === "list_tables") return [{ name: "users", kind: "table" }, { name: "orders", kind: "table" }];
      if (command === "search_global_data") {
        return {
          hits: [{ schema: null, table: "users", column: "email", primary_key: [["id", 7]], value: "a@example.test" }],
          tables_searched: 2,
          truncated: false,
          bytes: 64,
        };
      }
      return undefined;
    });
  });

  it("searches the selected connection scope and opens the matching row", async () => {
    render(<GlobalSearchView />);
    await waitFor(() => expect(screen.getByRole("button", { name: "users" })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Text to find"), { target: { value: "example" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByText("a@example.test");
    fireEvent.click(screen.getByTitle("Open and filter to this row"));
    expect(useWorkspace.getState().activeTabId).toBe("data:local::users:search:id=7");
    expect(useWorkspace.getState().tabs[0]).toMatchObject({
      kind: "table-data",
      connectionId: "local",
      table: "users",
      initialFilters: [{ column: "id", op: "eq", value: "7" }],
    });
  });
});
