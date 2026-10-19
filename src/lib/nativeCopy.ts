import { invoke } from "@tauri-apps/api/core";

export interface NativeCopyPreview {
  token: string;
  plan: { statements: string[]; warnings: string[]; transactional: boolean };
}
export interface NativeCopyProgress {
  phase: "preparing" | "creating" | "copying" | "finishing" | "cancelling";
  elapsed_ms: number;
}
export const nativeCopy = {
  preview: (id: string, source: string, target: string, schema?: string) =>
    invoke<NativeCopyPreview>("preview_native_copy", {
      id, request: { source_table: source, target_table: target, schema: schema ?? null },
    }),
  apply: (token: string, operationId: string) =>
    invoke<{ rows_copied: number; elapsed_ms: number }>("apply_native_copy", { token, operationId }),
  progress: (operationId: string) => invoke<NativeCopyProgress | null>("native_copy_progress", { operationId }),
  cancel: (operationId: string) => invoke<boolean>("cancel_native_copy", { operationId }),
};
