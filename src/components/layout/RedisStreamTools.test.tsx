import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisStreamTools } from "./RedisStreamTools";

const mocks = vi.hoisted(() => ({
  xadd: vi.fn(),
  xinfoGroups: vi.fn(),
  xgroupCreate: vi.fn(),
  xgroupDestroy: vi.fn(),
}));
vi.mock("@/lib/redisTools", () => ({ redisTools: mocks }));

describe("RedisStreamTools", () => {
  beforeEach(() => {
    mocks.xadd.mockReset().mockResolvedValue("1-0");
    mocks.xinfoGroups.mockReset().mockResolvedValue([]);
    mocks.xgroupCreate.mockReset().mockResolvedValue(undefined);
    mocks.xgroupDestroy.mockReset().mockResolvedValue(true);
  });
  afterEach(() => vi.clearAllMocks());

  it("appends entries with multiple fields", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<RedisStreamTools connectionId="c1" redisKey="events" onChanged={onChanged} />);
    fireEvent.change(screen.getByPlaceholderText(/Field name=Field value/), {
      target: { value: "kind=created\nuser=alice" },
    });
    fireEvent.click(screen.getByTitle("Append entry"));
    await waitFor(() => expect(mocks.xadd).toHaveBeenCalledWith("c1", "events", [["kind", "created"], ["user", "alice"]]));
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("creates and refreshes a consumer group", async () => {
    render(<RedisStreamTools connectionId="c1" redisKey="events" onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Consumer groups" }));
    await waitFor(() => expect(mocks.xinfoGroups).toHaveBeenCalledWith("c1", "events"));
    fireEvent.change(screen.getByPlaceholderText("Group name"), { target: { value: "workers" } });
    await waitFor(() => expect(screen.getByTitle("Create group")).toBeEnabled());
    fireEvent.click(screen.getByTitle("Create group"));
    await waitFor(() => expect(mocks.xgroupCreate).toHaveBeenCalledWith("c1", "events", "workers"));
  });

  it("hides stream mutations for read-only connections", () => {
    render(<RedisStreamTools connectionId="c1" redisKey="events" readOnly onChanged={vi.fn()} />);
    expect(screen.getByPlaceholderText(/Field name=Field value/)).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Consumer groups" }));
    expect(screen.getByPlaceholderText("Group name")).toBeDisabled();
    expect(screen.getByTitle("Create group")).toBeDisabled();
  });
});
