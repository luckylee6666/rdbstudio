import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { nextQueryTitle, useWorkspace } from "@/store/workspace";

/** Open in a new editor so loading a file never replaces unsaved SQL or runs it. */
export async function openSqlFile(connectionId?: string): Promise<void> {
  const path = await open({ multiple: false, directory: false, filters: [{ name: "SQL", extensions: ["sql"] }] });
  if (typeof path !== "string") return;
  const sql = await invoke<string>("read_sql_file", { path });
  const id = `query:${crypto.randomUUID()}`;
  sessionStorage.setItem(`rdb:sql:${id}`, sql);
  useWorkspace.getState().openTab({ id, kind: "query", title: path.split(/[\\/]/).pop() || nextQueryTitle(), connectionId });
}
