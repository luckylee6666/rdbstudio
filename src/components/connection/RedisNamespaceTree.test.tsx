import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TreeEntry } from "@/types";
import {
  buildRedisNamespaceTree,
  RedisNamespaceTree,
} from "./RedisNamespaceTree";

const key = (name: string, kind = "string"): TreeEntry => ({
  name,
  kind,
  ttl_ms: -1,
});

describe("buildRedisNamespaceTree", () => {
  it("keeps a key that is also a namespace prefix as a real entry", () => {
    const tree = buildRedisNamespaceTree([
      key("cache"),
      key("cache:user:1", "hash"),
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({
      segment: "cache",
      entry: { name: "cache", kind: "string" },
    });
    expect(tree[0].children[0].children[0].entry).toMatchObject({
      name: "cache:user:1",
      kind: "hash",
    });
  });

  it("filters by full key and caps namespace depth without changing the key", () => {
    const deepName = Array.from({ length: 80 }, (_, index) => `n${index}`).join(":");
    const tree = buildRedisNamespaceTree(
      [key("users:42"), key("other:42"), key(deepName)],
      "USERS:42"
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].segment).toBe("users");
    expect(tree[0].children[0].entry?.name).toBe("users:42");

    const deepTree = buildRedisNamespaceTree([key(deepName)]);
    let node = deepTree[0];
    let depth = 1;
    while (node.children.length) {
      node = node.children[0];
      depth++;
    }
    expect(depth).toBeLessThanOrEqual(32);
    expect(node.entry?.name).toBe(deepName);
  });
});

describe("RedisNamespaceTree", () => {
  it("opens matching ancestors and preserves full key, type, and click/context actions", () => {
    const entry = key("users:42:profile", "hash");
    const onOpen = vi.fn();
    const onContextMenu = vi.fn();
    render(
      <RedisNamespaceTree
        entries={[key("users:1"), entry]}
        filter="profile"
        selectedKey={entry.name}
        onOpen={onOpen}
        onContextMenu={onContextMenu}
      />
    );

    const leaf = screen.getByRole("button", { name: /profile.*hash/ });
    expect(leaf).toHaveAttribute("title", "users:42:profile\nhash · ∞");
    fireEvent.click(leaf);
    expect(onOpen).toHaveBeenCalledWith(entry);
    fireEvent.contextMenu(leaf);
    expect(onContextMenu).toHaveBeenCalledWith(
      entry,
      expect.objectContaining({ type: "contextmenu" })
    );
    expect(document.querySelector('[title^="users:1"]')).toBeNull();
  });

  it("keeps the existing binary type icon and label for module keys", () => {
    render(
      <RedisNamespaceTree
        entries={[key("doc", "ReJSON-RL")]}
        filter=""
        onOpen={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );
    expect(screen.getByText("ReJSON-RL")).toBeInTheDocument();
    expect(screen.getByLabelText("Binary")).toBeInTheDocument();
  });
});
