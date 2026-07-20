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
    const rawKids = Array.isArray(node["Plans"]) ? node["Plans"] : [];
    return {
      id,
      label,
      detail,
      cost: startup != null && total != null ? { startup, total } : undefined,
      rows: rows ?? undefined,
      children: rawKids.filter(isRecord).map(walk),
    };
  };
  return walk(plan);
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
