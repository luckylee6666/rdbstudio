import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RedisKeyDialog } from "./RedisKeyDialog";
import { useI18n } from "@/store/i18n";

describe("RedisKeyDialog", () => {
  beforeEach(() => {
    clearMocks();
    useI18n.setState({ lang: "en" });
  });

  afterEach(() => clearMocks());

  it("creates a hash key with field and TTL through redis_create_key", async () => {
    const calls: Record<string, unknown>[] = [];
    mockIPC((command, payload) => {
      if (command !== "redis_create_key") return undefined;
      calls.push(payload as Record<string, unknown>);
      return null;
    });
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(
      <RedisKeyDialog
        open
        connectionId="r1"
        onClose={onClose}
        onCreated={onCreated}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("user:1"), {
      target: { value: "session:1" },
    });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "hash" },
    });
    fireEvent.change(screen.getByPlaceholderText("name"), {
      target: { value: "user" },
    });
    fireEvent.change(screen.getByPlaceholderText("member"), {
      target: { value: "Alice" },
    });
    fireEvent.change(screen.getByPlaceholderText("empty = no expiry"), {
      target: { value: "60" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      id: "r1",
      key: "session:1",
      kind: "hash",
      value: "Alice",
      field: "user",
      score: null,
      ttlSecs: 60,
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid zset score before invoking the backend", async () => {
    const invoke = vi.fn();
    mockIPC((command) => {
      if (command === "redis_create_key") invoke();
      return undefined;
    });
    render(
      <RedisKeyDialog
        open
        connectionId="r1"
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("user:1"), {
      target: { value: "board" },
    });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "zset" },
    });
    fireEvent.change(screen.getByPlaceholderText("0"), {
      target: { value: "not-a-number" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText("score must be a number")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rejects a non-positive TTL before invoking the backend", async () => {
    const invoke = vi.fn();
    mockIPC((command) => {
      if (command === "redis_create_key") invoke();
      return undefined;
    });
    render(
      <RedisKeyDialog
        open
        connectionId="r1"
        onClose={() => {}}
        onCreated={() => {}}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("user:1"), {
      target: { value: "temp" },
    });
    fireEvent.change(screen.getByPlaceholderText("empty = no expiry"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText("TTL must be a positive whole number of seconds")
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and shows a backend duplicate-key error", async () => {
    mockIPC((command) => {
      if (command === "redis_create_key") {
        return Promise.reject(new Error('key "dup" already exists'));
      }
      return undefined;
    });
    const onClose = vi.fn();
    render(
      <RedisKeyDialog
        open
        connectionId="r1"
        onClose={onClose}
        onCreated={() => {}}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("user:1"), {
      target: { value: "dup" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
