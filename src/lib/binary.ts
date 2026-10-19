// Binary cells travel as base64 strings (or `{ $binary }` once edited).

export function isBinaryType(type: string): boolean {
  return /^(tinyblob|mediumblob|longblob|blob|bytea|binary|varbinary)(\(|$)/i.test(type.trim());
}

export function base64Of(value: unknown): string | null {
  if (value && typeof value === "object" && "$binary" in value) {
    return String((value as { $binary: unknown }).$binary);
  }
  return typeof value === "string" ? value : null;
}

export function base64ByteLength(b64: string): number {
  // Database values are canonical base64; compute their size without copying
  // or decoding the payload. Also accept wrapped text without allocating a
  // second multi-megabyte string just to strip its whitespace.
  if (!/\s/.test(b64)) {
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
  }
  let length = 0;
  let padding = 0;
  for (const char of b64) {
    if (/\s/.test(char)) continue;
    length++;
    padding = char === "=" ? padding + 1 : 0;
  }
  return Math.max(0, Math.floor((length * 3) / 4) - Math.min(padding, 2));
}

const SIGNATURES: Array<[prefix: string, mime: string, label: string]> = [
  ["iVBORw0KGgo", "image/png", "PNG"],
  ["/9j/", "image/jpeg", "JPEG"],
  ["R0lGOD", "image/gif", "GIF"],
  ["UklGR", "image/webp", "WEBP"],
  ["JVBERi0", "application/pdf", "PDF"],
  ["UEsDB", "application/zip", "ZIP"],
];

export function sniffBinary(b64: string): { mime: string; label: string } | null {
  for (const [prefix, mime, label] of SIGNATURES) {
    if (b64.startsWith(prefix)) {
      // RIFF is also WAV/AVI; WEBP has "WEBP" at byte 8 (base64 offset ~11).
      if (label === "WEBP" && !atobSafe(b64.slice(0, 16)).slice(8, 12).startsWith("WEBP")) continue;
      return { mime, label };
    }
  }
  return null;
}

function atobSafe(b64: string): string {
  try {
    return atob(b64);
  } catch {
    return "";
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/** Grid-friendly description, e.g. "PNG · 82 B" or "BLOB · 4.0 KB". */
export function binarySummary(value: unknown): string | null {
  const b64 = base64Of(value);
  if (b64 == null) return null;
  const kind = sniffBinary(b64)?.label ?? "BLOB";
  return `${kind} · ${formatBytes(base64ByteLength(b64))}`;
}
