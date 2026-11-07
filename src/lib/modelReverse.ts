import type { OfflineModel } from "./offlineModel";
export interface ModelSourceTable { schema: string; name: string }
export interface ModelReverseIssue { code: string; object: string }
export interface ModelReversePreview { model: OfflineModel; warnings: ModelReverseIssue[]; omitted_warnings: number }
export function reverseError(cause: unknown): string {
  const code = String(cause).replace(/^Error: /, "").replace(/^model_reverse_/, "");
  return ["busy", "timeout", "changed", "limit", "missing", "unsupported", "reference", "schema", "driver", "invalid"].includes(code) ? code : "read";
}
export const sourceKey = (table: ModelSourceTable): string => JSON.stringify([table.schema, table.name]);
