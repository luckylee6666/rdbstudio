import { add, compare, decimal, decimalText, projectionBudget, type Decimal } from "./resultAnalysis";
import { DEFAULT_TIME_OPTIONS, floorDivide, parseTime, timeBucket, timeLabel, TIME_BUCKETS } from "./resultTime";

export const CALCULATION_LIMITS = { fields: 16, expression: 4096, nodes: 512, depth: 32, text: 8192, operations: 20_000_000, rows: 50_000 } as const;
export const CALCULATION_TYPES = ["number", "text", "boolean", "time"] as const;
export type CalculationType = typeof CALCULATION_TYPES[number];
export interface CalculatedField { id: string; name: string; type: CalculationType; expression: string }
export interface CalculationColumn { name: string; data_type?: string }
export interface CalculationPlan { fields: CalculatedField[]; sourceCount: number; inputs: number[]; numericInputs: number[]; projection: number[] }
export interface CalculationStats { roundedRows: number; fields: string[] }
export interface CalculationPreview { rows: { value: string | boolean | null; rounded: boolean }[][]; count: number; stats: CalculationStats }
export class CalculationError extends Error {
  constructor(public code: string, public position = -1, public field = -1, public row = -1) { super(`calculation_${code}`); }
}
const fail = (code: string, position = -1): never => { throw new CalculationError(code, position); };
export const numericCalculationInput = (type = "") => /^(?:tinyint|smallint|mediumint|bigint|int\d*|integer|int2|int4|int8|float\d*|double(?: precision)?|real|numeric|decimal|number|money)(?:\b|\()/i.test(type);
export const calculationColumns = (fields: CalculatedField[]): CalculationColumn[] => fields.map(f => ({ name: f.name, data_type: { number: "DECIMAL", text: "TEXT", boolean: "BOOLEAN", time: "TIMESTAMP" }[f.type] }));
type Node = { kind: "number" | "string"; value: string; pos: number } | { kind: "null" | "true" | "false"; pos: number }
  | { kind: "ref"; index: number; pos: number } | { kind: "call"; name: string; args: Node[]; pos: number };
interface Token { kind: "number" | "string" | "ref" | "word" | "operator" | "end"; value: string; start: number; end: number }
const signatures: Record<string, [number, number]> = {
  IF: [3, 3], COALESCE: [1, 32], IFNULL: [2, 2], NULLIF: [2, 2], ISNULL: [1, 1],
  NUMBER: [1, 1], TEXT: [1, 1], ABS: [1, 1], ROUND: [1, 2], FLOOR: [1, 1], CEIL: [1, 1], TRUNC: [1, 1], DIVIDE: [3, 3], MIN: [2, 32], MAX: [2, 32],
  CONCAT: [1, 32], LOWER: [1, 1], UPPER: [1, 1], TRIM: [1, 1], LENGTH: [1, 1], SUBSTRING: [2, 3], REPLACE: [3, 3], CONTAINS: [2, 2], STARTSWITH: [2, 2], ENDSWITH: [2, 2],
  DATE: [3, 3], YEAR: [1, 1], MONTH: [1, 1], DAY: [1, 1], HOUR: [1, 1], MINUTE: [1, 1], SECOND: [1, 1], WEEKDAY: [1, 1], DATEADD: [3, 3], DATEDIFF: [3, 3], DATE_TRUNC: [2, 2],
};
export const CALCULATION_FUNCTIONS = Object.keys(signatures);
function lex(expression: string): Token[] {
  if (!expression.trim() || expression.length > CALCULATION_LIMITS.expression) return fail("expression");
  const tokens: Token[] = []; let p = 0;
  const push = (kind: Token["kind"], value: string, start: number) => { tokens.push({ kind, value, start, end: p }); if (tokens.length > CALCULATION_LIMITS.nodes * 3) fail("complexity", start); };
  while (p < expression.length) {
    if (/\s/u.test(expression[p])) { p++; continue; }
    const start = p, c = expression[p];
    if (c === "'") {
      p++; let value = "", closed = false;
      while (p < expression.length) { const c = expression[p++]; if (c === "'") { if (expression[p] === "'") { value += "'"; p++; } else { closed = true; break; } } else value += c; }
      if (!closed) fail("syntax", start); push("string", value, start); continue;
    }
    if (c === "[") { const match = /^\[([1-9]\d{0,4})\]/.exec(expression.slice(p)); if (!match) fail("reference", start); p += match![0].length; push("ref", match![1], start); continue; }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expression.slice(p));
    if (number) { p += number[0].length; push("number", number[0], start); continue; }
    const word = /^[A-Za-z_][A-Za-z_0-9]*/.exec(expression.slice(p));
    if (word) { p += word[0].length; push("word", word[0].toUpperCase(), start); continue; }
    const op = /^(?:<=|>=|!=|<>|==|\|\||&&|[+\-*/%=<>!(),])/.exec(expression.slice(p));
    if (!op) fail("syntax", start); p += op![0].length; push("operator", op![0], start);
  }
  tokens.push({ kind: "end", value: "", start: p, end: p }); return tokens;
}
const precedences: Record<string, number> = { OR: 1, "||": 1, AND: 2, "&&": 2, "=": 3, "==": 3, "!=": 3, "<>": 3, "<": 3, "<=": 3, ">": 3, ">=": 3, "+": 4, "-": 4, "*": 5, "/": 5, "%": 5 };
export function compileExpression(expression: string, columnCount: number): { node: Node; references: number[] } {
  const tokens = lex(expression), refs = new Set<number>(); let index = 0, nodes = 0;
  const node = <T extends Node>(value: T): T => { if (++nodes > CALCULATION_LIMITS.nodes) fail("complexity", value.pos); return value; };
  const parse = (minimum: number, depth: number): Node => {
    if (depth > CALCULATION_LIMITS.depth) return fail("complexity", tokens[index].start);
    const token = tokens[index++]; let left: Node;
    if (token.value === "(" && token.kind === "operator") { left = parse(0, depth + 1); if (tokens[index++].value !== ")") fail("syntax", token.start); }
    else if (["+", "-", "!", "NOT"].includes(token.value) && ["operator", "word"].includes(token.kind)) left = node({ kind: "call", name: token.value === "+" ? "POS" : token.value === "-" ? "NEG" : "NOT", args: [parse(token.value === "NOT" ? 3 : 6, depth + 1)], pos: token.start });
    else if (token.kind === "number") { if (!decimal(token.value)) fail("number", token.start); left = node({ kind: "number", value: token.value, pos: token.start }); }
    else if (token.kind === "string") left = node({ kind: "string", value: token.value, pos: token.start });
    else if (token.kind === "ref") { const reference = Number(token.value) - 1; if (reference >= columnCount) fail("reference", token.start); refs.add(reference); left = node({ kind: "ref", index: reference, pos: token.start }); }
    else if (token.kind === "word" && ["NULL", "TRUE", "FALSE"].includes(token.value)) left = node({ kind: token.value.toLowerCase() as "null" | "true" | "false", pos: token.start });
    else if (token.kind === "word" && Object.hasOwn(signatures, token.value)) {
      if (tokens[index++].value !== "(") fail("syntax", token.start);
      const args: Node[] = [];
      if (tokens[index].value !== ")") { while (true) { args.push(parse(0, depth + 1)); if (tokens[index].value !== ",") break; index++; } }
      if (tokens[index++].value !== ")" || args.length < signatures[token.value][0] || args.length > signatures[token.value][1]) fail("arguments", token.start);
      left = node({ kind: "call", name: token.value, args, pos: token.start });
    } else return fail("syntax", token.start);
    while (tokens[index] && Object.hasOwn(precedences, tokens[index].value) && precedences[tokens[index].value] >= minimum && ["operator", "word"].includes(tokens[index].kind)) {
      const operator = tokens[index++]; left = node({ kind: "call", name: operator.value, args: [left, parse(precedences[operator.value] + 1, depth + 1)], pos: operator.start });
    }
    return left;
  };
  try { const root = parse(0, 0); if (tokens[index]?.kind !== "end") fail("syntax", tokens[index]?.start); return { node: root, references: [...refs] }; }
  catch (cause) { if (cause instanceof CalculationError) throw cause; return fail("syntax", Math.min(expression.length, tokens[Math.min(index, tokens.length - 1)].start)); }
}
export function rewriteReferences(expression: string, map: (index: number) => number): string {
  const refs = lex(expression).filter(t => t.kind === "ref"); let result = expression;
  for (const token of refs.reverse()) { const next = map(Number(token.value) - 1); if (!Number.isInteger(next) || next < 0 || next > 65534) fail("reference", token.start); result = result.slice(0, token.start) + `[${next + 1}]` + result.slice(token.end); }
  return result;
}
export function validateCalculatedFields(fields: CalculatedField[], columns: CalculationColumn[]) {
  if (fields.length > CALCULATION_LIMITS.fields || columns.length + fields.length > 65535) fail("limit");
  const ids = new Set<string>(), names = new Set(columns.map(c => c.name.trim().toLowerCase()));
  return fields.map((field, index) => {
    try {
      if (!field || !/^[A-Za-z0-9_-]{1,64}$/.test(field.id) || ids.has(field.id) || !CALCULATION_TYPES.includes(field.type)) fail("invalid");
      const name = field.name.trim();
      if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name) || names.has(name.toLowerCase())) fail("name");
      ids.add(field.id); names.add(name.toLowerCase()); return compileExpression(field.expression, columns.length + index);
    } catch (cause) { if (cause instanceof CalculationError) cause.field = index; throw cause; }
  });
}
export function prepareCalculations(fields: CalculatedField[], columns: CalculationColumn[], projection?: number[]): CalculationPlan {
  const compiled = validateCalculatedFields(fields, columns);
  const used = new Set<number>();
  for (const expression of compiled) for (const ref of expression.references) if (ref < columns.length) used.add(ref);
  for (const ref of projection ?? []) if (ref >= 0 && ref < columns.length) used.add(ref);
  const inputs = [...used].sort((a,b) => a-b);
  return { fields, sourceCount: columns.length, inputs, numericInputs: inputs.filter(i => numericCalculationInput(columns[i].data_type)), projection: projection ?? fields.map((_, i) => columns.length + i) };
}

type Value = Decimal | string | boolean | null;
interface Cell { value: Value; rounded: boolean }
const isDecimal = (value: Value): value is Decimal => typeof value === "object" && value !== null;
const ten = (n: number) => 10n ** BigInt(n);
const abs = (n: bigint) => n < 0n ? -n : n;
function checked(value: Decimal): Decimal {
  if (value.scale > 1536 || value.coefficient.toString().length > 1537) fail("overflow");
  // Verify a compact representation fits the exact-decimal analysis domain.
  compact(value); return value;
}
function compact(value: Decimal): string {
  if (!value.coefficient) return "0";
  let coefficient = value.coefficient, scale = value.scale;
  while (coefficient % 10n === 0n) { coefficient /= 10n; scale--; }
  let digits = abs(coefficient).toString(), exponent = -scale;
  let mantissa = digits;
  if (exponent > 512) { if (digits.length + exponent - 512 > 256) return fail("overflow"); mantissa += "0".repeat(exponent - 512); exponent = 512; }
  if (exponent < -512) {
    const fractionPlaces = scale - 512;
    if (Math.max(digits.length, fractionPlaces) > 256) return fail("overflow");
    mantissa = fractionPlaces >= digits.length ? "." + "0".repeat(fractionPlaces - digits.length) + digits
      : digits.slice(0, digits.length - fractionPlaces) + "." + digits.slice(digits.length - fractionPlaces);
    exponent = -512;
  }
  if (mantissa.replace('.', '').length > 256) return fail("overflow");
  const result = (coefficient < 0n ? "-" : "") + mantissa + (exponent ? `e${exponent}` : "");
  if (!decimal(result)) return fail("overflow");
  // Prefer readable fixed-point values within the same supported input size.
  const fixed = decimalText(value); return decimal(fixed) ? fixed : result;
}
function numeric(value: Value): Decimal { const result = isDecimal(value) ? value : typeof value === "string" ? decimal(value) : null; return result ?? fail("type"); }
function string(value: Value): string { if (typeof value !== "string") return fail("type"); return value; }
function boolean(value: Value): boolean | null { if (value === null || typeof value === "boolean") return value; return fail("type"); }
function integer(value: Value, minimum: number, maximum: number): number { const d = numeric(value), divisor = ten(d.scale); if (d.coefficient % divisor !== 0n) return fail("arguments"); const n = Number(d.coefficient / divisor); return Number.isSafeInteger(n) && n >= minimum && n <= maximum ? n : fail("arguments"); }
function compareValues(a: Value, b: Value): number {
  if (isDecimal(a) || isDecimal(b)) return compare(numeric(a), numeric(b));
  if (typeof a !== typeof b || a === null || b === null) return fail("type");
  return a < b ? -1 : a > b ? 1 : 0;
}
function divide(a: Decimal, b: Decimal, places?: number): Cell {
  if (!b.coefficient) return fail("zero");
  let numerator = a.coefficient * ten(b.scale), denominator = b.coefficient * ten(a.scale);
  if (denominator < 0n) { denominator = -denominator; numerator = -numerator; }
  if (places === undefined) {
    let left = abs(numerator), right = denominator;
    while (right) { const remainder = left % right; left = right; right = remainder; }
    numerator /= left; denominator /= left;
    let twos = 0, fives = 0;
    while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
    while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
    if (denominator !== 1n) return fail("precision");
    const scale = Math.max(twos, fives); return { value: checked({ coefficient: numerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives), scale }), rounded: false };
  }
  const scaled = numerator * ten(places); let quotient = scaled / denominator; const remainder = scaled % denominator;
  if (abs(remainder) * 2n >= denominator) quotient += numerator < 0n ? -1n : 1n;
  return { value: checked({ coefficient: quotient, scale: places }), rounded: remainder !== 0n };
}
function rounded(d: Decimal, places: number, mode: string): Cell {
  if (d.scale <= places) return { value: d, rounded: false };
  const divisor = ten(d.scale - places); let q = d.coefficient / divisor; const remainder = d.coefficient % divisor;
  if (mode === "ROUND" && abs(remainder) * 2n >= divisor || mode === "FLOOR" && remainder < 0n || mode === "CEIL" && remainder > 0n) q += d.coefficient < 0n ? -1n : 1n;
  return { value: checked(places < 0 ? { coefficient: q * ten(-places), scale: 0 } : { coefficient: q, scale: places }), rounded: remainder !== 0n };
}
const time = (v: Value) => parseTime(string(v), DEFAULT_TIME_OPTIONS) ?? fail("time");
const unitNs = (value: Value) => { const unit = string(value).toLowerCase(); const units: Record<string, bigint> = { day: 86400_000_000_000n, hour: 3600_000_000_000n, minute: 60_000_000_000n, second: 1_000_000_000n }; return Object.hasOwn(units, unit) ? units[unit] : fail("arguments"); };
function evaluate(root: Node, get: (index: number) => Cell, step: () => void): Cell {
  const visit = (node: Node): Cell => {
    step();
    try {
      if (node.kind === "number") return { value: decimal(node.value)!, rounded: false };
      if (node.kind === "string") return { value: node.value, rounded: false };
      if (node.kind === "null" || node.kind === "true" || node.kind === "false") return { value: node.kind === "null" ? null : node.kind === "true", rounded: false };
      if (node.kind === "ref") return get(node.index);
      if (node.kind !== "call") return fail("syntax");
      const name = node.name;
      if (name === "IF") { const cond = visit(node.args[0]); const cell = visit(node.args[boolean(cond.value) ? 1 : 2]); return { ...cell, rounded: cell.rounded || cond.rounded }; }
      if (name === "COALESCE" || name === "IFNULL") { let wasRounded = false; for (const arg of node.args) { const cell = visit(arg); wasRounded ||= cell.rounded; if (cell.value !== null) return { ...cell, rounded: wasRounded }; } return { value: null, rounded: wasRounded }; }
      if (["AND", "OR", "&&", "||"].includes(name)) {
        const a = visit(node.args[0]), left = boolean(a.value), and = name === "AND" || name === "&&";
        if (and && left === false || !and && left === true) return a;
        const b = visit(node.args[1]), right = boolean(b.value);
        return { value: and ? right === false ? false : left === null || right === null ? null : true : right === true ? true : left === null || right === null ? null : false, rounded: a.rounded || b.rounded };
      }
      const cells = node.args.map(visit), args = cells.map(c => c.value), wasRounded = cells.some(c => c.rounded);
      const cell = (value: Value, rounded = false): Cell => {
        if (typeof value === "string" && value.length > CALCULATION_LIMITS.text) fail("text");
        if (isDecimal(value)) checked(value);
        return { value, rounded: wasRounded || rounded };
      };
      if (name === "ISNULL") return cell(args[0] === null);
      if (name === "NULLIF") return cell(args[0] === null || args[1] !== null && compareValues(args[0], args[1]) === 0 ? null : args[0]);
      if (args.some(a => a === null)) return cell(null);
      if (["=", "==", "!=", "<>", "<", "<=", ">", ">="].includes(name)) { const c = compareValues(args[0], args[1]); return cell(name === "=" || name === "==" ? c === 0 : name === "!=" || name === "<>" ? c !== 0 : name === "<" ? c < 0 : name === "<=" ? c <= 0 : name === ">" ? c > 0 : c >= 0); }
      if (name === "NOT") return cell(!boolean(args[0]));
      if (["POS", "NEG", "ABS", "NUMBER"].includes(name)) { const n = numeric(args[0]); return cell({ ...n, coefficient: name === "NEG" ? -n.coefficient : name === "ABS" ? abs(n.coefficient) : n.coefficient }); }
      if (["+", "-", "*", "/", "%", "DIVIDE"].includes(name)) {
        const a = numeric(args[0]), b = numeric(args[1]);
        if (name === "+" || name === "-") return cell(add(a, { ...b, coefficient: name === "-" ? -b.coefficient : b.coefficient }));
        if (name === "*") return cell({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
        if (name === "%") { if (!b.coefficient) fail("zero"); const scale = Math.max(a.scale,b.scale); return cell({ coefficient: (a.coefficient * ten(scale-a.scale)) % (b.coefficient * ten(scale-b.scale)), scale }); }
        const result = divide(a, b, name === "DIVIDE" ? integer(args[2],0,128) : undefined); return cell(result.value, result.rounded);
      }
      if (["ROUND", "FLOOR", "CEIL", "TRUNC"].includes(name)) { const result = rounded(numeric(args[0]), name === "ROUND" && args.length > 1 ? integer(args[1],-128,128) : 0, name); return cell(result.value, result.rounded); }
      if (name === "MIN" || name === "MAX") { let value = numeric(args[0]); for (const arg of args.slice(1)) { const next = numeric(arg); if (compare(next, value) === (name === "MIN" ? -1 : 1)) value = next; } return cell(value); }
      if (name === "TEXT") return cell(isDecimal(args[0]) ? decimalText(args[0]) : String(args[0]));
      if (name === "CONCAT") return cell(args.map(string).join(""));
      if (["LOWER", "UPPER", "TRIM", "LENGTH"].includes(name)) { const s = string(args[0]); return cell(name === "LOWER" ? s.toLowerCase() : name === "UPPER" ? s.toUpperCase() : name === "TRIM" ? s.trim() : { coefficient: BigInt(Array.from(s).length), scale: 0 }); }
      if (name === "SUBSTRING") { const s = Array.from(string(args[0])), start = integer(args[1], 1, Number.MAX_SAFE_INTEGER) - 1, count = args.length > 2 ? integer(args[2],0,Number.MAX_SAFE_INTEGER) : s.length; return cell(s.slice(start, start + count).join("")); }
      if (name === "REPLACE") { const source = string(args[0]), search = string(args[1]), replacement = string(args[2]); if (!search) fail("arguments"); if (replacement.length > search.length && source.length / search.length * replacement.length > CALCULATION_LIMITS.text) { const count = source.split(search).length - 1; if (source.length + count * (replacement.length-search.length) > CALCULATION_LIMITS.text) fail("text"); } return cell(source.split(search).join(replacement)); }
      if (["CONTAINS", "STARTSWITH", "ENDSWITH"].includes(name)) { const a=string(args[0]), b=string(args[1]); return cell(name === "CONTAINS" ? a.includes(b) : name === "STARTSWITH" ? a.startsWith(b) : a.endsWith(b)); }
      if (name === "DATE") { const y = integer(args[0],1,9999), m = integer(args[1],1,12), d = integer(args[2],1,31); const text = `${String(y).padStart(4,"0")}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`; time(text); return cell(text); }
      if (name === "DATE_TRUNC") { const bucket = string(args[0]); if (!TIME_BUCKETS.includes(bucket as typeof TIME_BUCKETS[number])) fail("arguments"); return cell(timeLabel(timeBucket(time(args[1]), bucket as typeof TIME_BUCKETS[number]))); }
      if (name === "DATEADD") { const ns = time(args[0]) + BigInt(integer(args[1],-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER)) * unitNs(args[2]); if (parseTime(ns.toString(), { ...DEFAULT_TIME_OPTIONS, input: "nanoseconds" }) === null) fail("time"); return cell(timeLabel(ns)); }
      if (name === "DATEDIFF") return cell({ coefficient: (time(args[1])-time(args[0])) / unitNs(args[2]), scale: 0 });
      const ns = time(args[0]), date = new Date(Number(floorDivide(ns, 1_000_000n)));
      const value = name === "YEAR" ? date.getUTCFullYear() : name === "MONTH" ? date.getUTCMonth()+1 : name === "DAY" ? date.getUTCDate() : name === "HOUR" ? date.getUTCHours() : name === "MINUTE" ? date.getUTCMinutes() : name === "SECOND" ? date.getUTCSeconds() : (date.getUTCDay()+6)%7+1;
      return cell({ coefficient: BigInt(value), scale: 0 });
    } catch (cause) { if (cause instanceof CalculationError && cause.position < 0) cause.position = node.pos; throw cause; }
  };
  return visit(root);
}

export function calculateRows(rows: unknown[][], plan: CalculationPlan, preview = false): { rows: unknown[][]; stats: CalculationStats; preview?: CalculationPreview } {
  if (rows.length > CALCULATION_LIMITS.rows || !Number.isInteger(plan.sourceCount) || plan.sourceCount < 0 || plan.sourceCount > 65535) fail("limit");
  const columns = Array.from({ length: plan.sourceCount }, () => ({ name: "" }));
  const compiled = validateCalculatedFields(plan.fields, columns);
  const inputMap = new Map(plan.inputs.map((source,i) => [source,i])), numericInputs = new Set(plan.numericInputs);
  if (inputMap.size !== plan.inputs.length || plan.inputs.some(i => !Number.isInteger(i) || i < 0 || i >= plan.sourceCount) || plan.numericInputs.some(i => !inputMap.has(i)) || plan.projection.some(i => !Number.isInteger(i) || i < -1 || i >= plan.sourceCount + plan.fields.length)) fail("reference");
  if (plan.projection.some(i => i >= 0 && i < plan.sourceCount && !inputMap.has(i))) fail("reference");
  if (compiled.some(c => c.references.some(i => i < plan.sourceCount && !inputMap.has(i)))) fail("reference");
  let operations = 0, roundedRows = 0; const step = () => { if (++operations > CALCULATION_LIMITS.operations) fail("budget"); };
  const output: unknown[][] = [], previews: CalculationPreview["rows"] = [], budget = projectionBudget(), inputBudget = projectionBudget();
  for (let row = 0; row < rows.length; row++) {
    const source = rows[row]; inputBudget(source); if (source.length !== plan.inputs.length) fail("reference");
    const cells: Cell[] = [], sourceCells = new Map<number, Cell>(); let rowRounded = false;
    const get = (index: number): Cell => {
      if (index < 0) return { value: null, rounded: false };
      if (index >= plan.sourceCount) return cells[index-plan.sourceCount] ?? fail("reference");
      const cached = sourceCells.get(index); if (cached) return cached;
      const cache = (cell: Cell) => { sourceCells.set(index,cell); return cell; };
      const slot = inputMap.get(index); if (slot === undefined) return fail("reference");
      const value = source[slot];
      if (value === null || value === undefined) return cache({ value: null, rounded: false });
      if (numericInputs.has(index) || typeof value === "number") { const n=decimal(value); if (!n) fail("type"); return cache({ value: n!, rounded: false }); }
      if (typeof value === "string" || typeof value === "boolean") { if (typeof value === "string" && value.length > CALCULATION_LIMITS.text) fail("text"); return cache({ value, rounded: false }); }
      return fail("type");
    };
    for (let field = 0; field < compiled.length; field++) {
      try {
        const cell = { ...evaluate(compiled[field].node, get, step) }, type=plan.fields[field].type;
        if (cell.value !== null) {
          if (type === "number") cell.value = checked(numeric(cell.value));
          if (type === "text") string(cell.value);
          if (type === "boolean") boolean(cell.value);
          if (type === "time") cell.value = timeLabel(time(cell.value));
        }
        cells.push(cell); rowRounded ||= cell.rounded;
      } catch (cause) { if (cause instanceof CalculationError) { cause.field = field; cause.row = row; } throw cause; }
    }
    if (rowRounded) roundedRows++;
    const serialize = (cell: Cell) => ({ value: isDecimal(cell.value) ? compact(cell.value) : cell.value, rounded: cell.rounded });
    // Original selected columns preserve their actual type, including JSON/binary, if formulas do not use them.
    const projected = plan.projection.map(i => i < 0 ? null : i < plan.sourceCount ? source[inputMap.get(i)!] : serialize(get(i)).value);
    budget(projected);
    if (!preview) output.push(projected);
    if (preview && previews.length < 20) previews.push(cells.map(serialize));
  }
  const stats = { roundedRows, fields: plan.fields.map(f => f.name) };
  return { rows: output, stats, ...(preview ? { preview: { rows: previews, count: rows.length, stats } } : {}) };
}
