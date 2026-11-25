import {
  compileQuery, MAX_SELECT_ARMS, emptyGroup, emptyQuery, QueryBuilderError,
  type ColumnExpression, type ComparisonOperator, type Condition, type ConditionGroup,
  type Expression, type QueryDesign, type QuerySource, type SqlDriver, type UnionOperator, type UnionArm,
} from "./queryBuilder";

const uuid = () => crypto.randomUUID();
const bareName = /^[a-zA-Z_][a-zA-Z_0-9$]*$/;
const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
const reserved = new Set((
  "SELECT DISTINCT DISTINCTROW ALL FROM AS ONLY TABLE WHERE GROUP BY HAVING ORDER LIMIT OFFSET " +
  "JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL ON USING AND OR NOT IN IS BETWEEN LIKE " +
  "UNION INTERSECT EXCEPT WITH RECURSIVE WINDOW OVER FILTER FOR INTO FETCH NULLS FIRST LAST " +
  "ASC DESC COLLATE ISNULL NOTNULL CASE WHEN THEN ELSE END EXISTS LATERAL TABLESAMPLE PARTITION INDEXED USE FORCE IGNORE " +
  "SQL_CALC_FOUND_ROWS SQL_NO_CACHE SQL_CACHE SQL_SMALL_RESULT SQL_BIG_RESULT SQL_BUFFER_RESULT HIGH_PRIORITY STRAIGHT_JOIN"
).split(" "));

function reject(code: string): never { throw new QueryBuilderError("import_" + code); }

// Tokenize only the forms this design can render. Comments, positional parameters and
// session-dependent quoting must never be dropped while converting a query.
function tokenize(sql: string, driver: SqlDriver): string[] {
  if (sql.length > 64 * 1024) reject("size");
  if (sql.includes("\0")) reject("syntax");
  const token = /[ \t\r\n]+|[eE]'(?:\\[\s\S]|''|[^'\\])*'|[xX]'(?:[0-9a-fA-F]{2})*'|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|:[A-Za-z_][A-Za-z_0-9]*|[a-zA-Z_][a-zA-Z_0-9$]*|<>|!=|<=|>=|[(),.*;=<>+-]/y;
  const tokens: string[] = [];
  let depth = 0;
  while (token.lastIndex < sql.length) {
    const index = token.lastIndex;
    if (sql.startsWith("--", index) || sql.startsWith("/*", index) || sql[index] === "#") reject("syntax");
    const word = token.exec(sql)?.[0];
    if (!word) reject("syntax");
    if (/^[ \t\r\n]/.test(word)) continue;
    // A dialect-specific number (e.g. 0x20) must not become 0 AS x20.
    if (number.test(word) && /^[A-Za-z_$]/.test(sql[token.lastIndex] ?? "")) reject("syntax");
    if ((word.startsWith('"') && driver === "mysql") || (word.startsWith("`") && driver !== "mysql")) reject("quoting");
    const pgEscapeString = driver === "postgres" && /^[eE]'/.test(word);
    if (word.includes("\\") && driver !== "sqlite" && !pgEscapeString) reject("quoting");
    if (word === "(") depth++;
    if (word === ")") depth--;
    if (depth < 0 || depth > 16) reject("syntax");
    if (tokens.length >= 4096) reject("size");
    tokens.push(word);
  }
  if (depth !== 0) reject("syntax");
  if (tokens.at(-1) === ";") tokens.pop();
  if (tokens.includes(";") || tokens[0]?.toUpperCase() !== "SELECT") reject("statement");
  return tokens;
}

export function importSelect(sql: string, driver: SqlDriver): QueryDesign {
  const tokens = tokenize(sql, driver);
  const parts: { operator: UnionOperator; tokens: string[] }[] = [];
  let start = 0, depth = 0;
  let operator: UnionOperator = "UNION";
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "(") depth++;
    if (tokens[i] === ")") depth--;
    if (depth || tokens[i].toUpperCase() !== "UNION") continue;
    parts.push({ operator, tokens: tokens.slice(start, i) });
    if (parts.length >= MAX_SELECT_ARMS) throw new QueryBuilderError("union_limit");
    const all = tokens[i + 1]?.toUpperCase() === "ALL";
    if (all) i++;
    else if (driver !== "sqlite" && tokens[i + 1]?.toUpperCase() === "DISTINCT") i++;
    operator = all ? "UNION ALL" : "UNION";
    start = i + 1;
  }
  parts.push({ operator, tokens: tokens.slice(start) });
  const parsed = parts.map((part, index) => parseSelect(part.tokens, driver, index === parts.length - 1));
  const head = parsed[0];
  if (parts.length > 1) {
    const tail = parsed[parsed.length - 1];
    head.orderBy = tail.orderBy; head.limit = tail.limit; head.offset = tail.offset;
    head.unions = parsed.slice(1).map((arm, i): UnionArm => {
      const { orderBy, limit, offset, ...select } = arm;
      return { id: uuid(), operator: parts[i + 1].operator, select };
    });
  }
  compileQuery(head, driver);
  return head;
}

function parseSelect(tokens: string[], driver: SqlDriver, allowTail: boolean): QueryDesign {
  if (tokens[0]?.toUpperCase() !== "SELECT") reject("syntax");
  let pos = 1;
  const peek = () => tokens[pos]?.toUpperCase() ?? "";
  const take = (word: string) => { if (peek() !== word) return false; pos++; return true; };
  const need = (word: string) => { if (!take(word)) reject("syntax"); };
  const query = emptyQuery();
  query.limit = "";
  query.distinct = take("DISTINCT");
  if (!query.distinct) take("ALL");

  function isName(raw = "") {
    return raw.startsWith('"') || raw.startsWith("`") || bareName.test(raw) && !reserved.has(raw.toUpperCase());
  }
  function name() {
    const raw = tokens[pos++];
    if (!isName(raw)) reject("syntax");
    const quote = raw[0];
    if (quote === '"' || quote === "`") {
      if (raw.length === 2) reject("syntax");
      return raw.slice(1, -1).replaceAll(quote + quote, quote);
    }
    return driver === "postgres" ? raw.toLowerCase() : raw;
  }
  function list<T>(next: () => T): T[] {
    const items = [next()];
    while (take(",")) items.push(next());
    return items;
  }
  function expression(): Expression {
    const raw = tokens[pos] ?? "";
    if (raw.startsWith(":")) {
      pos++;
      return { kind: "parameter", name: raw.slice(1) };
    }
    if (driver === "postgres" && /^[eE]'/.test(raw)) {
      pos++;
      const body = raw.slice(2, -1);
      if (body.replace(/\\\\|\\'/g, "").includes("\\")) reject("quoting");
      return { kind: "literal", type: "text", value: body.replace(/\\(\\|')|''/g, (_, escaped) => escaped ?? "'") };
    }
    // The builder emits MySQL strings containing backslashes as UTF-8 hex.
    if (driver === "mysql" && take("CONVERT")) {
      need("(");
      const hex = tokens[pos++];
      if (!/^[xX]'(?:[a-fA-F0-9]{2})*'$/.test(hex ?? "")) reject("syntax");
      need("USING"); need("UTF8MB4"); need(")");
      const bytes = Uint8Array.from(hex.slice(2, -1).match(/../g) ?? [], b => parseInt(b, 16));
      try {
        return { kind: "literal", type: "text", value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
      } catch { return reject("quoting"); }
    }
    if (raw.startsWith("'")) {
      pos++;
      return { kind: "literal", type: "text", value: raw.slice(1, -1).replaceAll("''", "'"), plainString: true };
    }
    const sign = take("-") ? "-" : take("+") ? "+" : "";
    if (number.test(tokens[pos] ?? "")) return { kind: "literal", type: "number", value: sign + tokens[pos++] };
    if (sign) reject("syntax");
    if (take("NULL")) return { kind: "literal", type: "null", value: "" };
    if (take("TRUE") || take("FALSE")) return { kind: "literal", type: "boolean", value: raw.toLowerCase() };
    const fn = peek();
    if (["COUNT", "SUM", "AVG", "MIN", "MAX"].includes(fn) && tokens[pos + 1] === "(") {
      pos += 2;
      const distinct = take("DISTINCT");
      const column = take("*") ? null : columnRef();
      need(")");
      return { kind: "aggregate", fn: fn as Extract<Expression, { kind: "aggregate" }>["fn"], distinct, column };
    }
    return columnRef();
  }
  function columnRef(): ColumnExpression {
    const raw = tokens[pos];
    const first = name();
    if (!take(".")) return { kind: "column", tableId: null, name: first, bare: bareName.test(raw) };
    const source = query.sources.find(s => driver === "sqlite"
      ? s.alias.replace(/[A-Z]/g, c => c.toLowerCase()) === first.replace(/[A-Z]/g, c => c.toLowerCase())
      : s.alias === first);
    if (!source) reject("reference");
    return { kind: "column", tableId: source.id, name: name() };
  }
  function group(node: Condition): ConditionGroup {
    return node.kind === "group" ? node : { ...emptyGroup(), children: [node] };
  }
  function combine(logic: "AND" | "OR", parse: () => Condition): Condition {
    const children = [parse()];
    while (take(logic)) children.push(parse());
    return children.length === 1 ? children[0] : { ...emptyGroup(), logic, children };
  }
  const disjunction = (): Condition => combine("OR", () => combine("AND", predicate));
  function predicate(): Condition {
    const not = take("NOT");
    if (take("(")) {
      const node = group(disjunction());
      need(")");
      return not ? { ...node, not: !node.not } : node;
    }
    // Prefix NOT without parentheses depends on MySQL's HIGH_NOT_PRECEDENCE.
    if (not && driver === "mysql") reject("syntax");
    const left = expression();
    let op: ComparisonOperator;
    let values: Expression[] = [];
    if (take("IS")) {
      op = take("NOT") ? "IS NOT NULL" : "IS NULL";
      need("NULL");
    } else {
      const negated = take("NOT");
      if (take("IN")) { op = negated ? "NOT IN" : "IN"; need("("); values = list(expression); need(")"); }
      else if (take("BETWEEN")) { op = negated ? "NOT BETWEEN" : "BETWEEN"; values.push(expression()); need("AND"); values.push(expression()); }
      else if (take("LIKE")) { op = negated ? "NOT LIKE" : "LIKE"; values = [expression()]; }
      else {
        if (negated || !["=", "!=", "<>", "<", ">", "<=", ">="].includes(peek())) reject("syntax");
        const operator = tokens[pos++];
        op = operator === "!=" ? "<>" : operator as ComparisonOperator;
        values = [expression()];
      }
    }
    const rule: Condition = { id: uuid(), kind: "rule", left, op, values };
    return not ? { ...group(rule), not: true } : rule;
  }
  function source(join: QuerySource["join"]) {
    const first = name();
    const qualified = take(".");
    const table = qualified ? name() : first;
    if (driver === "mysql" && !qualified && table.toUpperCase() === "DUAL") reject("syntax");
    const alias = take("AS") || isName(tokens[pos]) ? name() : table;
    const item = { id: uuid(), name: table, schema: qualified ? first : undefined, alias, join, on: emptyGroup() };
    query.sources.push(item);
    return item;
  }

  // Bind qualified projection columns after the sources and JOIN scopes exist.
  const projectionStart = pos;
  const from = tokens.findIndex(t => t.toUpperCase() === "FROM");
  if (from !== -1) {
    pos = from + 1;
    source("INNER");
    while (["JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS"].includes(peek())) {
      const join = peek() === "JOIN" ? "INNER" : tokens[pos++].toUpperCase() as QuerySource["join"];
      if (["LEFT", "RIGHT", "FULL"].includes(join)) take("OUTER");
      need("JOIN");
      const item = source(join);
      if (join !== "CROSS") { need("ON"); item.on = group(disjunction()); }
    }
  }
  const afterSources = pos;
  pos = projectionStart;
  if (!take("*")) query.columns = list(() => {
    // MySQL BINARY is a unary cast, not a column with an implicit alias.
    if (driver === "mysql" && peek() === "BINARY") reject("syntax");
    const value = expression();
    const alias = take("AS") || isName(tokens[pos]) ? name() : "";
    return { id: uuid(), expression: value, alias };
  });
  if (from !== -1) {
    if (pos !== from) reject("syntax");
    pos = afterSources;
  }
  if (take("WHERE")) query.where = group(disjunction());
  if (take("GROUP")) { need("BY"); query.groupBy = list(() => ({ id: uuid(), expression: expression() })); }
  if (take("HAVING")) query.having = group(disjunction());
  if (!allowTail && pos !== tokens.length) reject("syntax");
  if (take("ORDER")) {
    need("BY");
    query.orderBy = list(() => {
      const value = expression();
      const direction = peek() === "DESC" ? "DESC" : "ASC";
      take(direction);
      return { id: uuid(), expression: value, direction };
    });
  }
  function pageValue() {
    const value = tokens[pos++];
    if (!value || !(value.startsWith(":") || /^\d+$/.test(value))) reject("syntax");
    return value;
  }
  if (take("LIMIT")) query.limit = pageValue();
  if (take("OFFSET")) query.offset = pageValue();
  if (pos !== tokens.length) reject("syntax");
  return query;
}
