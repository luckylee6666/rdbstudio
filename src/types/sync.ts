import type { DriverKind } from "@/types";

export interface SyncRequest {
  source_id: string;
  target_id: string;
  source_schema?: string | null;
  source_table: string;
  target_schema?: string | null;
  target_table: string;
  compare_deletes: boolean;
}

export interface ColumnChange {
  name: string;
  source_type?: string | null;
  target_type?: string | null;
  kind: string;
  supported: boolean;
  detail?: string | null;
}

export interface StructurePlan {
  source_table: string;
  target_table: string;
  target_exists: boolean;
  changes: ColumnChange[];
  statements: string[];
  supported: boolean;
  reason?: string | null;
  ddl_transactional: boolean;
}

export interface SyncCounts {
  inserts: number;
  updates: number;
  deletes: number;
  unchanged: number;
  sample_conflict_keys: string[];
}

export interface SyncPreview {
  token: string;
  source_driver: DriverKind;
  target_driver: DriverKind;
  structure: StructurePlan;
  data_supported: boolean;
  data_reason?: string | null;
  counts: SyncCounts;
  rows_examined: number;
  bytes_examined: number;
}

export type ConflictPolicy = "insert_only" | "overwrite" | "mirror";

export interface SyncReport {
  inserted: number;
  updated: number;
  deleted: number;
  structure_statements: number;
  structure_applied_before_data: boolean;
  transactional: boolean;
}

export interface SearchRequest {
  connection_id: string;
  schema?: string | null;
  tables: string[];
  text: string;
  case_sensitive: boolean;
  limit: number;
}

export interface SearchHit {
  schema?: string | null;
  table: string;
  column: string;
  primary_key: [string, unknown][];
  value: unknown;
}

export interface SearchResult {
  hits: SearchHit[];
  tables_searched: number;
  truncated: boolean;
  bytes: number;
}
