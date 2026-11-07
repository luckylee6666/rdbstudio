/** Explicit, deterministic UTC time handling; no browser-locale date parsing. */
export const TIME_INPUTS = ["iso", "seconds", "milliseconds", "microseconds", "nanoseconds"] as const;
export const TIME_BUCKETS = ["instant", "second", "minute", "hour", "day", "week", "month", "quarter", "year"] as const;
export interface TimeOptions {
  input: typeof TIME_INPUTS[number];
  naive: "utc" | "reject";
  bucket: typeof TIME_BUCKETS[number];
}
export const DEFAULT_TIME_OPTIONS: TimeOptions = { input: "iso", naive: "utc", bucket: "instant" };
const NS = 1_000_000_000n, DAY = 86400n * NS;
// Gregorian years 0001 through 9999, with a half-open upper boundary.
const MIN = -62135596800n * NS, MAX = 253402300800n * NS;
export const floorDivide = (value: bigint, divisor: bigint) => value / divisor - (value % divisor < 0n ? 1n : 0n);
const inRange = (value: bigint) => value >= MIN && value < MAX;
const dateAt = (year: number, month: number, day: number) => {
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); return date;
};
function epoch(value: unknown, unit: Exclude<TimeOptions["input"], "iso">): bigint | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value))) return null;
  const text = String(value).trim();
  if (text.length > 64) return null;
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || match[2].length + (match[3]?.length ?? 0) > 30) return null;
  const exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 30) return null;
  const precision = { seconds: 9, milliseconds: 6, microseconds: 3, nanoseconds: 0 }[unit];
  const shift = precision + exponent - (match[3]?.length ?? 0);
  const coefficient = BigInt(match[1] + match[2] + (match[3] ?? ""));
  const factor = 10n ** BigInt(Math.abs(shift));
  if (shift < 0 && coefficient % factor !== 0n) return null;
  const result = shift >= 0 ? coefficient * factor : coefficient / factor;
  return inRange(result) ? result : null;
}
/** ISO-like calendar dates / SQL timestamps, or an explicitly selected Unix unit. */
export function parseTime(value: unknown, options: TimeOptions): bigint | null {
  if (options.input !== "iso") return epoch(value, options.input);
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?([Zz]|[+-]\d{2}(?::?\d{2})?)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, ys, ms, ds, hs, mins, secs, fraction, zone] = match;
  const year = Number(ys), month = Number(ms), day = Number(ds);
  const hour = Number(hs ?? 0), minute = Number(mins ?? 0), second = Number(secs ?? 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const date = dateAt(year, month, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (hs && !zone && options.naive === "reject") return null;
  let offset = 0;
  if (zone && !/^[Zz]$/.test(zone)) {
    const digits = zone.slice(1).replace(":", ""), h = Number(digits.slice(0, 2)), m = Number(digits.slice(2) || 0);
    // RFC 3339 negative zero has an unknown local offset but a known UTC instant.
    if (h > 23 || m > 59) return null;
    offset = (h * 60 + m) * (zone[0] === "-" ? -1 : 1);
  }
  const result = BigInt(date.getTime() / 1000 + hour * 3600 + minute * 60 + second - offset * 60) * NS + BigInt((fraction ?? "").padEnd(9, "0"));
  return inRange(result) ? result : null;
}
export function timeBucket(value: bigint, bucket: TimeOptions["bucket"]): bigint {
  if (bucket === "instant") return value;
  const units = { second: NS, minute: 60n * NS, hour: 3600n * NS, day: DAY };
  if (bucket in units) { const unit = units[bucket as keyof typeof units]; return floorDivide(value, unit) * unit; }
  if (bucket === "week") return (floorDivide(floorDivide(value, DAY) + 3n, 7n) * 7n - 3n) * DAY;
  const date = new Date(Number(floorDivide(value, 1_000_000n))), year = date.getUTCFullYear(), month = date.getUTCMonth();
  const start = dateAt(year, bucket === "year" ? 1 : bucket === "quarter" ? Math.floor(month / 3) * 3 + 1 : month + 1, 1);
  return BigInt(start.getTime()) * 1_000_000n;
}
/** Full UTC label, retaining up to nine fractional digits. */
export function timeLabel(value: bigint): string {
  const seconds = floorDivide(value, NS), fraction = value - seconds * NS;
  const date = new Date(Number(seconds * 1000n));
  const suffix = fraction ? "." + fraction.toString().padStart(9, "0").replace(/0+$/, "") : "";
  return date.toISOString().slice(0, 19) + suffix + "Z";
}
