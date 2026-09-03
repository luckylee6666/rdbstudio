import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryEditorView } from "./QueryEditorView";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import { useWorkspace } from "@/store/workspace";
import type { ConnectionConfig, WorkspaceTab } from "@/types";

vi.mock("@/components/editor/CodeMirror", () => ({
  CodeMirrorEditor: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="SQL editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

describe("QueryEditorView buffer persistence", () => {
  const tab: WorkspaceTab = {
    id: "query:buffer-test",
    kind: "query",
    title: "Query",
  };

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  });

  it("flushes the latest SQL when switching tabs inside the debounce window", () => {
    const { unmount } = render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: "SELECT 'kept';" },
    });

    unmount();

    expect(localStorage.getItem(`rdb:buf:${tab.id}`)).toBe("SELECT 'kept';");
  });

  it("does not recreate storage for a deliberately closed tab", () => {
    const { unmount } = render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: "SELECT 'closed';" },
    });
    act(() => useWorkspace.setState({ tabs: [], activeTabId: null }));

    unmount();

    expect(localStorage.getItem(`rdb:buf:${tab.id}`)).toBeNull();
  });
});

describe("QueryEditorView script failure reporting", () => {
  const tab: WorkspaceTab = { id: "query:script", kind: "query", title: "Query" };
  const mysql: ConnectionConfig = {
    id: "my",
    name: "mysql-test",
    driver: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    group: null,
    ssl_mode: "disable",
  };

  const calls: Record<string, unknown>[] = [];

  function runScript(outcome: Record<string, unknown>, sql?: string) {
    mockIPC((command, payload) => {
      if (command !== "execute_script") return undefined;
      calls.push(payload as Record<string, unknown>);
      return outcome;
    });
    render(<QueryEditorView tab={tab} />);
    fireEvent.change(screen.getByLabelText("SQL editor"), {
      target: { value: sql ?? "ALTER TABLE t ADD COLUMN a INT;\nSELECT bad;" },
    });
    fireEvent.click(screen.getByRole("button", { name: /运行/ }));
  }

  beforeEach(() => {
    clearMocks();
    calls.length = 0;
    localStorage.clear();
    sessionStorage.clear();
    useI18n.setState({ lang: "zh" });
    useConnections.setState({
      list: [mysql],
      loaded: true,
      status: { my: "connected" },
      versions: {},
      branches: {},
      errors: {},
      treeFilter: "",
    });
    useWorkspace.setState({ tabs: [tab], activeTabId: tab.id });
  });

  afterEach(() => clearMocks());

  it("promises a full rollback only when the backend confirms one", async () => {
    runScript({
      status: "failed",
      failed_index: 1,
      statements: 2,
      error: "boom",
      rollback: "complete",
    });

    await waitFor(() =>
      expect(screen.getByText(/已整体回滚/)).toBeInTheDocument()
    );
    expect(calls[0]?.atomic).toBe(true);
  });

  it("warns that MySQL already applied the DDL when the rollback was partial", async () => {
    runScript({
      status: "failed",
      failed_index: 1,
      statements: 2,
      error: "boom",
      rollback: "partial",
    });

    await waitFor(() =>
      expect(screen.getByText(/结构变更已经生效/)).toBeInTheDocument()
    );
    expect(screen.queryByText(/已整体回滚/)).toBeNull();
  });

  it("sends a self-managed transaction as one non-atomic script", async () => {
    // Statement by statement these would scatter across pooled connections and
    // the ROLLBACK would land on a connection that never saw the UPDATE.
    runScript(
      {
        status: "failed",
        failed_index: 2,
        statements: 3,
        error: "boom",
        rollback: "self_managed",
      },
      "BEGIN;\nUPDATE t SET a = 1;\nROLLBACK;"
    );

    await waitFor(() =>
      expect(screen.getByText(/脚本自行管理事务/)).toBeInTheDocument()
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.atomic).toBe(false);
    expect(calls[0]?.sqls).toEqual([
      "BEGIN",
      "UPDATE t SET a = 1",
      "ROLLBACK",
    ]);
  });
});
