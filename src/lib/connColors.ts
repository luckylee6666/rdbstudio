/// Preset environment-tag colors for connections. Stored in
/// ConnectionConfig.color as the token name; rendered via this map so the
/// palette stays consistent between the dialog swatches and the tree.
export const CONN_COLORS: Record<string, string> = {
  red: "#ef4444",
  amber: "#f59e0b",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
  pink: "#ec4899",
};

export function connColorValue(token: string | null | undefined): string | null {
  if (!token) return null;
  return CONN_COLORS[token] ?? token;
}
