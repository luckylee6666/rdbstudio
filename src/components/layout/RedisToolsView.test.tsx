import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisToolsView } from "./RedisToolsView";

const mocks = vi.hoisted(() => ({
  pubsubStart: vi.fn(),
  pubsubPoll: vi.fn(),
  pubsubStop: vi.fn(),
  clusterSnapshot: vi.fn(),
}));

vi.mock("@/lib/redisTools", () => ({ redisTools: mocks }));
vi.mock("@/lib/api", () => ({
  api: {
    executeQuery: vi.fn().mockResolvedValue({
      columns: [{ name: "value", data_type: "string" }],
      rows: [["# Server\r\nredis_version:8.0.0\r\nconnected_clients:3\r\ndb0:keys=5,expires=0"]],
      rows_affected: null,
      elapsed_ms: 1,
      truncated: false,
    }),
  },
}));

describe("RedisToolsView", () => {
  beforeEach(() => {
    mocks.pubsubStart.mockReset().mockResolvedValue("sub-1");
    mocks.pubsubPoll.mockReset().mockResolvedValue({
      messages: [{ channel: "orders", payload: "created", binary: false, received_at_ms: 1 }],
      dropped: 0,
      stopped: false,
    });
    mocks.pubsubStop.mockReset().mockResolvedValue(undefined);
    mocks.clusterSnapshot.mockReset().mockResolvedValue({ info: "cluster_state:ok", nodes: ["node-1"] });
  });
  afterEach(() => vi.clearAllMocks());

  it("starts an independent Pub/Sub subscription and displays received messages", async () => {
    const view = render(<RedisToolsView connectionId="c1" onBack={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Channel or pattern"), { target: { value: "orders*" } });
    fireEvent.click(screen.getByRole("button", { name: "Subscribe" }));
    await waitFor(() => expect(mocks.pubsubStart).toHaveBeenCalledWith("c1", "orders*"));
    expect(await screen.findByText("created")).toBeInTheDocument();
    expect(mocks.pubsubPoll).toHaveBeenCalledWith("c1", "sub-1", 50);
    view.unmount();
    await waitFor(() => expect(mocks.pubsubStop).toHaveBeenCalledWith("c1", "sub-1"));
  });

  it("summarises INFO without recording it in the query history", async () => {
    const { api } = await import("@/lib/api");
    render(<RedisToolsView connectionId="c1" />);
    expect(await screen.findByText("8.0.0")).toBeInTheDocument();
    expect(screen.getByText("db0")).toBeInTheDocument();
    expect(api.executeQuery).toHaveBeenCalledWith("c1", "INFO", undefined, undefined, { recordHistory: false });
  });

  it("loads cluster info and node details on demand", async () => {
    render(<RedisToolsView connectionId="c1" onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Load cluster info" }));
    expect(await screen.findByText("cluster_state:ok")).toBeInTheDocument();
    expect(screen.getByText("node-1")).toBeInTheDocument();
  });
});
