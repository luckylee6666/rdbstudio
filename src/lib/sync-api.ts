import { invoke } from "@tauri-apps/api/core";
import type {
  SearchRequest,
  SearchResult,
  SyncPreview,
  SyncReport,
  SyncRequest,
  ConflictPolicy,
} from "@/types/sync";

export const syncApi = {
  preview: (request: SyncRequest) =>
    invoke<SyncPreview>("preview_sync", { request }),
  applyStructure: (token: string) =>
    invoke<SyncReport>("apply_structure_sync", { token }),
  applyData: (
    token: string,
    policy: ConflictPolicy,
    createMissingTable: boolean
  ) =>
    invoke<SyncReport>("apply_data_sync", {
      token,
      options: {
        policy,
        create_missing_table: createMissingTable,
      },
    }),
  search: (request: SearchRequest) =>
    invoke<SearchResult>("search_global_data", { request }),
};
