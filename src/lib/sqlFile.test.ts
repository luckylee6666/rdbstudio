import { afterEach, beforeEach, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useWorkspace } from "@/store/workspace";
import { openSqlFile } from "./sqlFile";

beforeEach(() => {
  sessionStorage.clear();
  useWorkspace.setState({ tabs: [{ id: "existing", kind: "query", title: "Unsaved" }], activeTabId: "existing" });
});
afterEach(() => clearMocks());

it("loads a SQL file into a new tab without executing it or replacing the current query", async () => {
  const calls: string[] = [];
  mockIPC((cmd, args) => {
    calls.push(cmd);
    if (cmd === "plugin:dialog|open") return "/tmp/example.sql";
    if (cmd === "read_sql_file") {
      expect(args).toEqual({ path: "/tmp/example.sql" });
      return "SELECT '中文';";
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  await openSqlFile("c1");
  const { tabs, activeTabId } = useWorkspace.getState();
  expect(tabs).toHaveLength(2);
  expect(tabs[0].id).toBe("existing");
  expect(tabs[1]).toMatchObject({ kind: "query", title: "example.sql", connectionId: "c1" });
  expect(sessionStorage.getItem(`rdb:sql:${activeTabId}`)).toBe("SELECT '中文';");
  expect(calls).toEqual(["plugin:dialog|open", "read_sql_file"]);
});

it("leaves tabs unchanged when file selection is cancelled", async () => {
  mockIPC((cmd) => {
    if (cmd === "plugin:dialog|open") return null;
    throw new Error("must not read or execute");
  });
  await openSqlFile("c1");
  expect(useWorkspace.getState().tabs).toHaveLength(1);
});

it("reports read errors without creating an empty query", async () => {
  mockIPC((cmd) => {
    if (cmd === "plugin:dialog|open") return "/tmp/large.sql";
    throw new Error("SQL files must be at most 8 MiB");
  });
  await expect(openSqlFile("c1")).rejects.toThrow("8 MiB");
  expect(useWorkspace.getState().tabs).toHaveLength(1);
  expect(useWorkspace.getState().activeTabId).toBe("existing");
});
