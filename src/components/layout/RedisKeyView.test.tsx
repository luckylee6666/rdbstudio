import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisKeyView } from "./RedisKeyView";
import type { WorkspaceTab } from "@/types";

const mocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  redisRenameMember: vi.fn(),
  redisDeleteMember: vi.fn(),
  refreshBranch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    executeQuery: mocks.executeQuery,
    redisRenameMember: mocks.redisRenameMember,
    redisDeleteMember: mocks.redisDeleteMember,
  },
}));
vi.mock("@/store/connections", () => ({
  useConnections: (selector: (state: { refreshBranch: typeof mocks.refreshBranch }) => unknown) =>
    selector({ refreshBranch: mocks.refreshBranch }),
}));
vi.mock("@/store/workspace", () => ({
  useWorkspace: (selector: (state: { closeTab: () => void; openTab: () => void }) => unknown) =>
    selector({ closeTab: vi.fn(), openTab: vi.fn() }),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      key: index,
      index,
      start: index * 29,
    })),
    measureElement: vi.fn(),
  }),
}));

const tab: WorkspaceTab = {
  id: "redis:c1:foo",
  kind: "redis-key",
  title: "foo",
  connectionId: "c1",
  redisKey: "foo",
  redisType: "hash",
};

function queryResult(rows: unknown[][]) {
  return { columns: [{ name: "field", data_type: "redis" }], rows, elapsed_ms: 1 };
}

describe("RedisKeyView edits", () => {
  beforeEach(() => {
    mocks.executeQuery.mockReset();
    mocks.redisRenameMember.mockReset();
    mocks.redisDeleteMember.mockReset();
    mocks.refreshBranch.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("does not save an edited cell after Escape cancels it", async () => {
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) =>
      sql.startsWith("PTTL") ? queryResult([[10000]]) : queryResult([["original", "value"]])
    );
    render(<RedisKeyView tab={tab} />);
    const cell = await screen.findByText("original");
    fireEvent.doubleClick(cell);
    const input = await screen.findByRole("textbox");
    fireEvent.change(input, { target: { value: "cancelled draft" } });
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
    expect(mocks.redisRenameMember).not.toHaveBeenCalled();
    expect(mocks.executeQuery.mock.calls.filter((call) => !String(call[1]).startsWith("PTTL"))).toHaveLength(1);
  });

  it("uses Redis KEEPTTL when saving a string key", async () => {
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) => {
      if (sql.startsWith("PTTL")) return queryResult([[5200]]);
      if (sql.startsWith("GET")) return queryResult([["before"]]);
      return queryResult([["OK"]]);
    });
    const stringTab = { ...tab, id: "redis:c1:scalar", redisKey: "scalar", redisType: "string" };
    render(<RedisKeyView tab={stringTab} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "after" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith("c1", 'SET "scalar" "after" KEEPTTL'));
  });

  it("blocks editing a truncated scalar reply", async () => {
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        ...queryResult([[sql.startsWith("PTTL") ? 10000 : "partial"]]),
        truncated: !sql.startsWith("PTTL"),
      };
    });
    const scalarTab = { ...tab, redisType: "string" };
    render(<RedisKeyView tab={scalarTab} />);
    expect(await screen.findByRole("button", { name: "Edit" })).toBeDisabled();
    fireEvent.doubleClick(screen.getByText("partial"));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
