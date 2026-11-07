export const parameterKinds = ["text", "integer", "decimal", "float", "boolean", "date", "datetime", "json", "binary"] as const;
export type ParameterKind = typeof parameterKinds[number];
export interface QueryParameter { name: string; kind: ParameterKind; value: string | null }
/** Only explicitly saved defaults include a value. Types are safe to remember. */
export interface ParameterDefault { name: string; kind: ParameterKind; value?: string | null }
export interface ParameterInput { name: string; kind: ParameterKind; value: string; isNull: boolean; saveDefault: boolean }

export function parameterInput(name: string, previous?: QueryParameter, saved?: ParameterDefault): ParameterInput {
  const value = previous?.value !== undefined ? previous.value : saved?.value;
  const kind = previous?.kind ?? saved?.kind ?? "text";
  return { name, kind, value: value ?? (kind === "boolean" ? "true" : ""), isNull: value === null, saveDefault: saved?.value !== undefined };
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

export function parameterError(input: ParameterInput): string | null {
  if (input.isNull) return null;
  const value = input.value;
  if (new TextEncoder().encode(value).length > 1024 * 1024) return "size";
  switch (input.kind) {
    case "integer":
      if (!/^[+-]?\d+$/.test(value)) return "integer";
      try { const number = BigInt(value); return number < -(2n ** 63n) || number > 2n ** 63n - 1n ? "integer" : null; } catch { return "integer"; }
    case "decimal": return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) ? null : "decimal";
    case "float": return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && Number.isFinite(Number(value)) ? null : "float";
    case "boolean": return value === "true" || value === "false" ? null : "boolean";
    case "date": return validDate(value) ? null : "date";
    case "datetime": {
      const parts = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?$/.exec(value);
      return parts && validDate(parts[1]) && Number(parts[2]) < 24 && Number(parts[3]) < 60 && Number(parts[4]) < 60 ? null : "datetime";
    }
    case "json": try { JSON.parse(value); return null; } catch { return "json"; }
    case "binary": return /^(?:0x)?(?:[\da-fA-F]{2})*$/.test(value) ? null : "binary";
    default: return null;
  }
}

export function mergeParameterDefaults(existing: ParameterDefault[], inputs: ParameterInput[]): ParameterDefault[] {
  const defaults = new Map(existing.map(value => [value.name, value]));
  for (const input of inputs) defaults.set(input.name, { name: input.name, kind: input.kind, ...(input.saveDefault ? { value: input.isNull ? null : input.value } : {}) });
  return [...defaults.values()];
}
