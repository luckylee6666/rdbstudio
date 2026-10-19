import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisKeyView } from "./RedisKeyView";
import type { WorkspaceTab } from "@/types";

const mocks = vi.hoisted(() => ({
  executeQuery: vi.fn(),
  redisRenameMember: vi.fn(),
  redisDeleteMember: vi.fn(),
  refreshBranch: vi.fn(),
  hscan: vi.fn(),
  sscan: vi.fn(),
  xrange: vi.fn(),
  listSetCas: vi.fn(),
  listDeleteCas: vi.fn(),
  xdel: vi.fn(),
  readOnly: false,
}));

vi.mock("@/lib/api", () => ({
  api: {
    executeQuery: mocks.executeQuery,
    redisRenameMember: mocks.redisRenameMember,
    redisDeleteMember: mocks.redisDeleteMember,
  },
}));
vi.mock("@/lib/redisTools", () => ({
  redisTools: {
    hscan: mocks.hscan,
    sscan: mocks.sscan,
    xrange: mocks.xrange,
    listSetCas: mocks.listSetCas,
    listDeleteCas: mocks.listDeleteCas,
    xdel: mocks.xdel,
  },
}));
vi.mock("@/store/connections", () => ({
  useConnections: (selector: (state: { refreshBranch: typeof mocks.refreshBranch; list: Array<{ id: string; read_only?: boolean }> }) => unknown) =>
    selector({ refreshBranch: mocks.refreshBranch, list: [{ id: "c1", read_only: mocks.readOnly }] }),
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
    mocks.hscan.mockReset().mockResolvedValue({ items: [{ field: "original", value: "value", field_binary: false, value_binary: false }], cursor: "0", done: true, truncated: false });
    mocks.sscan.mockReset().mockResolvedValue({ items: [], cursor: "0", done: true, truncated: false });
    mocks.xrange.mockReset().mockResolvedValue({ items: [], cursor: "0", done: true, truncated: false });
    mocks.listSetCas.mockReset().mockResolvedValue(undefined);
    mocks.listDeleteCas.mockReset().mockResolvedValue(undefined);
    mocks.xdel.mockReset().mockResolvedValue(1);
    mocks.refreshBranch.mockReset().mockResolvedValue(undefined);
    mocks.readOnly = false;
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
    expect(mocks.executeQuery.mock.calls.filter((call) => String(call[1]).startsWith("PTTL"))).toHaveLength(1);
    expect(mocks.hscan).toHaveBeenCalledWith("c1", "foo");
  });

  it("loads, displays, and adds a member for the empty-string key", async () => {
    mocks.hscan.mockResolvedValue({
      items: [{ field: "present-field", value: "present-value", field_binary: false, value_binary: false }],
      cursor: "0",
      done: true,
      truncated: false,
    });
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) => {
      if (sql.startsWith("PTTL")) return queryResult([[10000]]);
      if (sql.startsWith("HSETNX")) return queryResult([[1]]);
      return queryResult([]);
    });
    const emptyKeyTab = { ...tab, id: "redis:c1:", title: "", redisKey: "" };
    render(<RedisKeyView tab={emptyKeyTab} />);

    expect(await screen.findByText("present-field")).toBeInTheDocument();
    expect(mocks.hscan).toHaveBeenCalledWith("c1", "");
    fireEvent.click(screen.getByRole("button", { name: "Add entry" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Field" }), { target: { value: "new-field" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Value" }), { target: { value: "new-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith("c1", 'HSETNX "" "new-field" "new-value"'));
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

  it("pages through hash fields with the opaque HSCAN cursor", async () => {
    mocks.hscan
      .mockResolvedValueOnce({ items: [{ field: "first", value: "one", field_binary: false, value_binary: false }], cursor: "h1:19:0", done: false, truncated: false })
      .mockResolvedValueOnce({ items: [{ field: "second", value: "two", field_binary: false, value_binary: false }], cursor: "0", done: true, truncated: false });
    render(<RedisKeyView tab={tab} />);
    expect(await screen.findByText("first")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("second")).toBeInTheDocument();
    expect(mocks.hscan).toHaveBeenLastCalledWith("c1", "foo", "h1:19:0");
  });

  it("saves list edits through the expected-value CAS command", async () => {
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) =>
      sql.startsWith("PTTL") ? queryResult([[10000]]) : { ...queryResult([["before"]]), columns: [{ name: "value", data_type: "redis" }] }
    );
    const listTab = { ...tab, id: "redis:c1:list", redisKey: "list", redisType: "list" };
    render(<RedisKeyView tab={listTab} />);
    fireEvent.doubleClick(await screen.findByText("before"));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "after" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(mocks.listSetCas).toHaveBeenCalledWith("c1", "list", 0, "before", "after"));
  });

  it.each([
    { type: "hash", label: "Value", command: 'HSETNX "foo" "new-field" "new-value"', setup: async () => { fireEvent.change(screen.getByRole("textbox", { name: "Field" }), { target: { value: "new-field" } }); } },
    { type: "set", label: "Member", command: 'SADD "foo" "new-value"', setup: async () => {} },
    { type: "list", label: "Value", command: 'RPUSH "foo" "new-value"', setup: async () => {} },
    { type: "zset", label: "Member", command: 'ZADD "foo" NX 2.5 "new-value"', setup: async () => { fireEvent.change(screen.getByRole("textbox", { name: "Score" }), { target: { value: "2.5" } }); } },
  ])("adds a $type member with the correct Redis command", async ({ type, label, command, setup }) => {
    mocks.hscan.mockResolvedValue({ items: [], cursor: "0", done: true, truncated: false });
    mocks.sscan.mockResolvedValue({ items: [], cursor: "0", done: true, truncated: false });
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) => {
      if (sql.startsWith("PTTL")) return queryResult([[10000]]);
      if (sql.startsWith("HSETNX") || sql.startsWith("SADD") || sql.startsWith("RPUSH") || sql.startsWith("ZADD")) return queryResult([[1]]);
      return queryResult(type === "zset" ? [["existing", 1]] : [["existing"]]);
    });
    const collectionTab = { ...tab, id: `redis:c1:${type}`, redisKey: "foo", redisType: type };
    render(<RedisKeyView tab={collectionTab} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add entry" }));
    await setup();
    fireEvent.change(screen.getByRole("textbox", { name: label }), { target: { value: "new-value" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(mocks.executeQuery).toHaveBeenCalledWith("c1", command));
  });

  it("deletes the selected duplicate list slot with compare-and-swap", async () => {
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) =>
      sql.startsWith("PTTL") ? queryResult([[10000]]) : { ...queryResult([["duplicate"], ["middle"], ["duplicate"]]), columns: [{ name: "value", data_type: "redis" }] }
    );
    const listTab = { ...tab, id: "redis:c1:list-duplicates", redisKey: "list", redisType: "list" };
    render(<RedisKeyView tab={listTab} />);
    const deleteButtons = await screen.findAllByRole("button", { name: "Delete entry" });
    fireEvent.click(deleteButtons[2]);
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await waitFor(() => expect(mocks.listDeleteCas).toHaveBeenCalledWith("c1", "list", 2, "duplicate"));
  });

  it.each([
    { type: "hash", member: "field-a" },
    { type: "set", member: "member-a" },
    { type: "zset", member: "member-a" },
  ])("deletes a $type member through the guarded member API", async ({ type, member }) => {
    mocks.hscan.mockResolvedValue({ items: [{ field: member, value: "value", field_binary: false, value_binary: false }], cursor: "0", done: true, truncated: false });
    mocks.sscan.mockResolvedValue({ items: [member], cursor: "0", done: true, truncated: false });
    mocks.redisDeleteMember.mockResolvedValue(1);
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) => {
      if (sql.startsWith("PTTL")) return queryResult([[10000]]);
      return { ...queryResult([[member, 1]]), columns: [{ name: "member", data_type: "redis" }, { name: "score", data_type: "redis" }] };
    });
    const collectionTab = { ...tab, id: `redis:c1:${type}-delete`, redisType: type };
    render(<RedisKeyView tab={collectionTab} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete entry" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete" }).at(-1)!);
    await waitFor(() => expect(mocks.redisDeleteMember).toHaveBeenCalledWith("c1", "foo", type, member));
  });

  it("hides collection writes for read-only connections and disables binary deletion", async () => {
    mocks.readOnly = true;
    mocks.hscan.mockResolvedValue({ items: [{ field: "ordinary", value: "value", field_binary: false, value_binary: false }], cursor: "0", done: true, truncated: false });
    mocks.executeQuery.mockImplementation(async (_id: string, sql: string) => sql.startsWith("PTTL") ? queryResult([[10000]]) : queryResult([]));
    const readOnlyTab = { ...tab, redisType: "set" };
    const view = render(<RedisKeyView tab={readOnlyTab} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Add entry" })).toBeNull());
    view.unmount();

    mocks.readOnly = false;
    mocks.hscan.mockResolvedValue({ items: [{ field: "base64:/w==", value: "value", field_binary: true, value_binary: false }], cursor: "0", done: true, truncated: false });
    render(<RedisKeyView tab={tab} />);
    const deleteButton = await screen.findByRole("button", { name: "Delete entry" });
    expect(deleteButton).toBeDisabled();
    fireEvent.doubleClick(screen.getByText("base64:/w=="));
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
