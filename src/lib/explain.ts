// Pure parsing helpers for the visual EXPLAIN feature (ExplainView): they turn
// PostgreSQL `EXPLAIN (FORMAT JSON)` output and SQLite `EXPLAIN QUERY PLAN`
// rows into a driver-agnostic tree the view lays out with dagre. No React, no
// API calls — unit tested in explain.test.ts.

export interface PlanNode {
  id: string;
  label: string;
  detail?: string;
  cost?: { startup: number; total: number };
  rows?: number;
  // PostgreSQL `EXPLAIN ANALYZE` runtime measurements (per-loop averages, as
  // reported by the server). Absent for non-ANALYZE plans.
  actual?: { time?: number; rows?: number; loops?: number };
  children: PlanNode[];
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asInt(v: unknown): number | null {
  const n = asFiniteNumber(v);
  return n == null ? null : Math.trunc(n);
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// PostgreSQL: `EXPLAIN (FORMAT JSON, VERBOSE true) …` yields one row/column
// containing `[ { "Plan": { …, "Plans": [ … ] } } ]`. Depending on the driver
// the cell arrives as a decoded object (json/jsonb) or as a JSON string — both
// shapes are accepted here so the view can pass rows[0][0] straight through.
export function parsePgPlan(json: unknown): PlanNode {
  let data: unknown = json;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error("EXPLAIN returned a string that is not valid JSON");
    }
  }
  const entry = Array.isArray(data) ? data[0] : data;
  const plan = isRecord(entry) ? entry["Plan"] : null;
  if (!isRecord(plan)) {
    throw new Error(
      'Unexpected EXPLAIN JSON shape: missing the root "Plan" object'
    );
  }
  let seq = 0;
  const walk = (node: Record<string, unknown>): PlanNode => {
    const id = `pg-${seq++}`;
    const label = asString(node["Node Type"]) ?? "Unknown";
    const relation = asString(node["Relation Name"]);
    const schema = asString(node["Schema"]);
    const alias = asString(node["Alias"]);
    const index = asString(node["Index Name"]);
    let detail: string | undefined;
    if (relation) {
      detail = schema ? `${schema}.${relation}` : relation;
      if (alias && alias !== relation) detail += ` ${alias}`;
    } else if (index) {
      detail = index;
    }
    const startup = asFiniteNumber(node["Startup Cost"]);
    const total = asFiniteNumber(node["Total Cost"]);
    const rows = asFiniteNumber(node["Plan Rows"]);
    const actualTime = asFiniteNumber(node["Actual Total Time"]);
    const actualRows = asFiniteNumber(node["Actual Rows"]);
    const actualLoops = asFiniteNumber(node["Actual Loops"]);
    const actual =
      actualTime != null || actualRows != null || actualLoops != null
        ? {
            time: actualTime ?? undefined,
            rows: actualRows ?? undefined,
            loops: actualLoops ?? undefined,
          }
        : undefined;
    const rawKids = Array.isArray(node["Plans"]) ? node["Plans"] : [];
    return {
      id,
      label,
      detail,
      cost: startup != null && total != null ? { startup, total } : undefined,
      rows: rows ?? undefined,
      actual,
      children: rawKids.filter(isRecord).map(walk),
    };
  };
  return walk(plan);
}

// MySQL: `EXPLAIN FORMAT=JSON …` yields one row/column holding a JSON string
// with a `query_block` root. MySQL wraps operations in loosely-typed objects
// (`nested_loop`, `ordering_operation`, `materialized_from_subquery`, …) and
// the exact set varies across 5.7/8.x, so everything unknown falls back to a
// generic node labeled from its key — the graph must render even for a shape
// this parser has never seen.
const MYSQL_OPERATION_LABELS: Record<string, string> = {
  query_block: "Query Block",
  nested_loop: "Nested Loop",
  ordering_operation: "Ordering",
  grouping_operation: "Grouping",
  duplicates_removal: "Distinct",
  materialized_from_subquery: "Materialized Subquery",
  union_result: "Union Result",
  query_specifications: "Query Specifications",
};

// Scalar fields that describe an operation/table rather than nesting another
// one; they must not become generic child nodes.
const MYSQL_LEAF_KEYS = new Set([
  "select_id",
  "cost_info",
  "table_name",
  "access_type",
  "possible_keys",
  "key",
  "used_key_parts",
  "key_length",
  "ref",
  "rows_examined_per_scan",
  "rows_produced_per_join",
  "filtered",
  "data_read_per_join",
  "used_columns",
  "used_index",
  "partitions",
  "attached_condition",
  "index_condition",
  "using_filesort",
  "using_temporary_table",
  "dependent",
  "cacheable",
  "message",
  "read_cost",
  "eval_cost",
  "prefix_cost",
  "query_cost",
]);

function prettyKey(key: string): string {
  return key
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function parseMysqlPlan(json: unknown): PlanNode {
  let data: unknown = json;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      throw new Error("EXPLAIN returned a string that is not valid JSON");
    }
  }
  const entry = Array.isArray(data) ? data[0] : data;
  if (!isRecord(entry)) {
    throw new Error("Unexpected EXPLAIN JSON shape: expected an object");
  }
  let seq = 0;
  const nextId = () => `mysql-${seq++}`;

  const tableNode = (t: Record<string, unknown>): PlanNode => {
    const name = asString(t["table_name"]) ?? "Table";
    const access = asString(t["access_type"]);
    const key = asString(t["key"]);
    const possible = Array.isArray(t["possible_keys"])
      ? t["possible_keys"].filter(
          (k): k is string => typeof k === "string" && k.length > 0
        )
      : [];
    const examined = asFiniteNumber(t["rows_examined_per_scan"]);
    const produced = asFiniteNumber(t["rows_produced_per_join"]);
    const filteredRaw = t["filtered"];
    const filtered = asFiniteNumber(filteredRaw);
    const costInfo = isRecord(t["cost_info"]) ? t["cost_info"] : null;
    const read = costInfo ? asFiniteNumber(costInfo["read_cost"]) : null;
    const prefix = costInfo ? asFiniteNumber(costInfo["prefix_cost"]) : null;
    const detail: string[] = [];
    if (key) detail.push(`key ${key}`);
    else if (possible.length > 0) detail.push(`possible ${possible.join(", ")}`);
    if (filtered != null) {
      detail.push(
        `filtered ${
          typeof filteredRaw === "string" ? filteredRaw : String(filtered)
        }%`
      );
    }
    return {
      id: nextId(),
      label: access ? `${name} (${access})` : name,
      detail: detail.length > 0 ? detail.join(" · ") : undefined,
      cost: prefix != null ? { startup: read ?? 0, total: prefix } : undefined,
      rows: examined ?? produced ?? undefined,
      children: opChildren(t),
    };
  };

  const wrapperNode = (
    label: string,
    obj: Record<string, unknown>
  ): PlanNode => {
    const costInfo = isRecord(obj["cost_info"]) ? obj["cost_info"] : null;
    const total = costInfo
      ? asFiniteNumber(costInfo["query_cost"]) ??
        asFiniteNumber(costInfo["prefix_cost"])
      : null;
    const detail: string[] = [];
    const selectId = asFiniteNumber(obj["select_id"]);
    if (selectId != null) detail.push(`select_id ${selectId}`);
    if (obj["using_filesort"] === true) detail.push("using filesort");
    if (obj["using_temporary_table"] === true) {
      detail.push("using temporary table");
    }
    return {
      id: nextId(),
      label,
      detail: detail.length > 0 ? detail.join(" · ") : undefined,
      cost: total != null ? { startup: 0, total } : undefined,
      children: opChildren(obj),
    };
  };

  const listChildren = (items: unknown[]): PlanNode[] => {
    const out: PlanNode[] = [];
    for (const item of items) {
      if (Array.isArray(item)) {
        // Some servers nest join arrays one level deeper.
        out.push(...listChildren(item));
      } else if (isRecord(item) && isRecord(item["table"])) {
        out.push(tableNode(item["table"]));
      } else if (isRecord(item)) {
        out.push(...opChildren(item));
      }
    }
    return out;
  };

  const operationNode = (key: string, value: unknown): PlanNode | null => {
    if (isRecord(value)) return wrapperNode(MYSQL_OPERATION_LABELS[key] ?? prettyKey(key), value);
    if (Array.isArray(value)) {
      return {
        id: nextId(),
        label: MYSQL_OPERATION_LABELS[key] ?? prettyKey(key),
        children: listChildren(value),
      };
    }
    return null;
  };

  function opChildren(obj: Record<string, unknown>): PlanNode[] {
    const out: PlanNode[] = [];
    for (const [key, value] of Object.entries(obj)) {
      if (MYSQL_LEAF_KEYS.has(key)) continue;
      if (key === "table" && isRecord(value)) {
        out.push(tableNode(value));
        continue;
      }
      const op = operationNode(key, value);
      if (op) out.push(op);
    }
    return out;
  }

  const qb = isRecord(entry["query_block"]) ? entry["query_block"] : entry;
  return wrapperNode("Query Block", qb);
}

// SQLite: `EXPLAIN QUERY PLAN …` yields rows of [id, parent, notused, detail].
// parent = 0 marks a root (there is no node with id 0); rows referencing a
// parent id that never appears are treated as roots rather than dropped.
// A statement can produce multiple roots (e.g. compound SELECTs), hence the
// array return.
export function parseSqliteQueryPlan(rows: unknown[][]): PlanNode[] {
  const byId = new Map<number, PlanNode>();
  const order: { parent: number; node: PlanNode }[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 4) {
      throw new Error(
        "Unexpected EXPLAIN QUERY PLAN row: expected [id, parent, notused, detail]"
      );
    }
    const id = asInt(row[0]);
    const parent = asInt(row[1]);
    if (id == null || parent == null) {
      throw new Error(
        "Unexpected EXPLAIN QUERY PLAN row: id/parent are not numbers"
      );
    }
    const node: PlanNode = {
      id: `eqp-${id}`,
      label: row[3] == null ? "" : String(row[3]),
      children: [],
    };
    byId.set(id, node);
    order.push({ parent, node });
  }
  const roots: PlanNode[] = [];
  for (const { parent, node } of order) {
    const p = byId.get(parent);
    if (p && p !== node) p.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// Strip a leading EXPLAIN prefix (with its modifiers) so the view can re-wrap
// the statement in the driver-appropriate EXPLAIN form without double-wrapping.
// Handles `EXPLAIN`, `EXPLAIN QUERY PLAN`, `EXPLAIN ANALYZE [VERBOSE]`,
// `EXPLAIN (FORMAT JSON, …)` and MySQL's `EXPLAIN FORMAT=JSON`. Plain
// statements pass through untouched (modulo trimming).
export function stripLeadingExplain(sql: string): string {
  let s = sql.trim();
  const lead = /^EXPLAIN\b/i.exec(s);
  if (!lead) return s;
  s = s.slice(lead[0].length);
  const paren = /^\s*\([^)]*\)/.exec(s);
  if (paren) {
    s = s.slice(paren[0].length);
  } else {
    for (;;) {
      const mod = /^\s+(QUERY\s+PLAN|ANALYZE|VERBOSE|FORMAT\s*=\s*\w+)\b/i.exec(
        s
      );
      if (!mod) break;
      s = s.slice(mod[0].length);
    }
  }
  return s.trim();
}

// Depth-first flatten, used by the view to lay out and to scan for hotspots.
export function flattenPlan(roots: PlanNode[]): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (n: PlanNode) => {
    out.push(n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}

// PG total costs are cumulative — a node's Total Cost includes its children,
// so the root would always "win" a max-total comparison and hotspot detection
// would be useless. Self cost (total minus the children's totals, clamped at
// 0) is what a node itself contributes, which is what we highlight.
export function selfCost(node: PlanNode): number {
  if (!node.cost) return 0;
  const kids = node.children.reduce((s, c) => s + (c.cost?.total ?? 0), 0);
  return Math.max(0, node.cost.total - kids);
}
