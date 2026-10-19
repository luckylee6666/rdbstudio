import { useMemo, useState } from "react";
import {
  Activity,
  Binary,
  Braces,
  ChevronRight,
  FolderClosed,
  FolderOpen,
  Hash,
  Key,
  List,
  Type,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { TreeEntry } from "@/types";
import { useT } from "@/store/i18n";

const MAX_NAMESPACE_DEPTH = 32;

export interface RedisNamespaceNode {
  /** Full namespace prefix through this node. */
  path: string;
  segment: string;
  entry?: TreeEntry;
  children: RedisNamespaceNode[];
}

export interface RedisNamespaceTreeProps {
  /** All Redis keys currently loaded by the parent; pagination stays there. */
  entries: TreeEntry[];
  /** Filter is applied to complete key names before building the visible tree. */
  filter: string;
  selectedKey?: string | null;
  onOpen: (entry: TreeEntry) => void;
  onContextMenu: (entry: TreeEntry, event: React.MouseEvent<HTMLButtonElement>) => void;
}

interface MutableNode {
  path: string;
  segment: string;
  entry?: TreeEntry;
  children: Map<string, MutableNode>;
}

/**
 * Group loaded Redis keys by colon-separated namespace. Iterative insertion
 * and a depth cap keep both construction and React rendering bounded, while
 * retaining the original full key on the terminal node.
 */
export function buildRedisNamespaceTree(
  entries: TreeEntry[],
  filter = ""
): RedisNamespaceNode[] {
  const needle = filter.trim().toLocaleLowerCase();
  const roots = new Map<string, MutableNode>();

  for (const entry of entries) {
    if (needle && !entry.name.toLocaleLowerCase().includes(needle)) continue;

    const parts = entry.name.split(":");
    if (parts.length > MAX_NAMESPACE_DEPTH) {
      parts.splice(
        MAX_NAMESPACE_DEPTH - 1,
        parts.length - (MAX_NAMESPACE_DEPTH - 1),
        parts.slice(MAX_NAMESPACE_DEPTH - 1).join(":")
      );
    }

    let siblings = roots;
    let prefix = "";
    let current: MutableNode | undefined;
    for (const [index, segment] of parts.entries()) {
      prefix = index === 0 ? segment : `${prefix}:${segment}`;
      current = siblings.get(segment);
      if (!current) {
        current = { path: prefix, segment, children: new Map() };
        siblings.set(segment, current);
      }
      siblings = current.children;
    }
    if (current) current.entry = entry;
  }

  const freezeLevel = (nodes: Map<string, MutableNode>): RedisNamespaceNode[] =>
    [...nodes.values()]
      .sort((a, b) => a.segment.localeCompare(b.segment))
      .map((node) => ({
        path: node.path,
        segment: node.segment,
        entry: node.entry,
        children: freezeLevel(node.children),
      }));

  return freezeLevel(roots);
}

function typeIcon(kind: string): LucideIcon {
  switch (kind) {
    case "string":
      return Type;
    case "hash":
      return Hash;
    case "list":
      return List;
    case "set":
    case "zset":
      return Braces;
    case "stream":
      return Activity;
    case "ReJSON-RL":
      return Binary;
    default:
      return Key;
  }
}

function formatTtl(ms?: number | null): string {
  if (ms == null) return "—";
  if (ms === -1) return "∞";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function RedisNamespaceTree({
  entries,
  filter,
  selectedKey,
  onOpen,
  onContextMenu,
}: RedisNamespaceTreeProps) {
  const t = useT();
  const tree = useMemo(
    () => buildRedisNamespaceTree(entries, filter),
    [entries, filter]
  );
  const [openPaths, setOpenPaths] = useState<Set<string>>(() =>
    new Set(tree.filter((node) => node.children.length > 0).map((node) => node.path))
  );
  const filtering = !!filter.trim();

  const toggle = (path: string) => {
    setOpenPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const renderNode = (node: RedisNamespaceNode): React.ReactNode => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && (filtering || openPaths.has(node.path));
    const entry = node.entry;
    const FolderIcon = expanded ? FolderOpen : FolderClosed;
    const Icon = entry ? typeIcon(entry.kind) : FolderIcon;
    const label = node.segment || "∅";

    return (
      <div key={node.path}>
        <div className="flex min-w-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={t(expanded ? "redis.namespace.collapse" : "redis.namespace.expand", { name: node.path || "∅" })}
            aria-expanded={hasChildren ? expanded : undefined}
            disabled={!hasChildren}
            onClick={() => toggle(node.path)}
            className={cn(
              "grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent/50",
              !hasChildren && "invisible"
            )}
          >
            {hasChildren && (
              <ChevronRight
                className={cn(
                  "h-3 w-3 transition-transform",
                  expanded && "rotate-90"
                )}
              />
            )}
          </button>

          {entry ? (
            <button
              type="button"
              onClick={() => onOpen(entry)}
              onContextMenu={(event) => {
                event.preventDefault();
                onContextMenu(entry, event);
              }}
              title={`${entry.name}\n${entry.kind} · ${formatTtl(entry.ttl_ms)}`}
              className={cn(
                "group/key flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-foreground/85 hover:bg-accent/50",
                selectedKey === entry.name && "bg-accent/60 text-foreground"
              )}
            >
              <Icon
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-rose-700 dark:text-rose-300/90",
                  entry.kind === "ReJSON-RL" && "text-amber-700 dark:text-amber-300"
                )}
                aria-label={entry.kind === "ReJSON-RL" ? "Binary" : undefined}
              />
              <span className="min-w-0 flex-1 truncate">{label}</span>
              <span className="shrink-0 rounded px-1 text-[10px] text-muted-foreground">
                {entry.kind}
              </span>
              {entry.ttl_ms != null && (
                <span
                  className={cn(
                    "shrink-0 rounded px-1 text-[10px] tabular-nums",
                    entry.ttl_ms === -1
                      ? "text-muted-foreground/60"
                      : entry.ttl_ms < 60_000
                        ? "bg-warning/20 text-warning"
                        : "text-muted-foreground"
                  )}
                >
                  {formatTtl(entry.ttl_ms)}
                </span>
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => hasChildren && toggle(node.path)}
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] text-muted-foreground hover:bg-accent/50"
              title={node.path}
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          )}
        </div>
        {expanded && (
          <div className="ml-4 border-l border-border/40 pl-1">
            {node.children.map(renderNode)}
          </div>
        )}
      </div>
    );
  };

  return <div className="space-y-0.5">{tree.map(renderNode)}</div>;
}
