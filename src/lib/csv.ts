import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "./api";

export function toCSV(columns: string[], rows: unknown[][]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const header = columns.map(esc).join(",");
  const body = rows.map((r) => r.map(esc).join(",")).join("\n");
  return header + "\n" + body;
}

// Save text to a user-picked path. The classic browser pattern
// (Blob + URL.createObjectURL + <a download>) silently no-ops in Tauri's
// WKWebView, so we go through the dialog plugin + a Rust write_text_file
// command instead. Returns the chosen path, or null if the user cancelled.
export async function saveTextFile(
  defaultName: string,
  text: string,
  ext: string = "csv"
): Promise<string | null> {
  const picked = await saveDialog({
    defaultPath: defaultName,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (typeof picked !== "string") return null;
  await api.writeTextFile(picked, text);
  return picked;
}
