export type DriverKind = "sqlite" | "postgres" | "mysql" | "redis";

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: DriverKind;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  file_path?: string | null;
  color?: string | null;
  pinned?: boolean;
  /** Optional sidebar group label. Empty/undefined = ungrouped. */
  group?: string | null;
  password?: string | null;
}

export interface ConnectionSummary {
  id: string;
  connected: boolean;
  server_version?: string | null;
}

export interface TreeEntry {
  name: string;
  kind: string;
  schema?: string | null;
  comment?: string | null;
  /** Redis only: PTTL in milliseconds, -1 = no expiration. */
  ttl_ms?: number | null;
}

export interface ScanPage {
  keys: TreeEntry[];
  next_cursor: number;
  done: boolean;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  is_primary_key: boolean;
  default_value?: string | null;
}

export type FilterOp =
  | "eq"
  | "neq"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_null"
  | "not_null";

export interface Filter {
  column: string;
  op: FilterOp;
  value?: string;
}

export interface OrderBy {
  column: string;
  direction: "asc" | "desc";
}

export interface TableQuery {
  schema?: string;
  table: string;
  limit: number;
  offset: number;
  order_by?: OrderBy;
  filters: Filter[];
  where_raw?: string;
}

export type Edit =
  | { kind: "update"; pk: [string, unknown][]; set: [string, unknown][] }
  | { kind: "insert"; values: [string, unknown][] }
  | { kind: "delete"; pk: [string, unknown][] };

export interface EditBatch {
  schema?: string;
  table: string;
  edits: Edit[];
}

export interface EditResult {
  ok: boolean;
  applied: number;
  failed_at?: number | null;
  error?: string | null;
}

export interface ColumnDetail {
  name: string;
  data_type: string;
  nullable: boolean;
  default?: string | null;
  comment?: string | null;
  ordinal_position: number;
  char_max_length?: number | null;
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  is_primary_key: boolean;
  is_auto_increment: boolean;
}

export interface ForeignKey {
  name: string;
  columns: string[];
  referenced_schema?: string | null;
  referenced_table: string;
  referenced_columns: string[];
  on_update?: string | null;
  on_delete?: string | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  is_unique: boolean;
  is_primary: boolean;
  method?: string | null;
}

export interface TableDescription {
  schema?: string | null;
  name: string;
  comment?: string | null;
  columns: ColumnDetail[];
  primary_key: string[];
  foreign_keys: ForeignKey[];
  indexes: IndexInfo[];
  row_estimate?: number | null;
  size_bytes?: number | null;
}

export interface ColumnEdit {
  original_name?: string | null;
  name: string;
  data_type: string;
  nullable: boolean;
  default?: string | null;
  is_primary_key: boolean;
}

export interface DesignerChange {
  columns: ColumnEdit[];
}

export interface AlterPlan {
  statements: string[];
  warnings: string[];
}

export type ExportFormat = "csv" | "json" | "sql";

export interface ExportOptions {
  format: ExportFormat;
  path: string;
  delimiter?: string;
  include_header?: boolean;
  quote_all?: boolean;
  batch_size?: number;
}

export interface ExportReport {
  rows_written: number;
  bytes: number;
  elapsed_ms: number;
}

export type ImportMode = "append" | "truncate_insert";

export interface ImportCsvOptions {
  path: string;
  schema?: string | null;
  table: string;
  delimiter?: string;
  has_header?: boolean;
  mode: ImportMode;
  column_map?: string[] | null;
}

export interface ImportReport {
  rows_read: number;
  rows_inserted: number;
  errors: string[];
  elapsed_ms: number;
}

export interface CsvPreview {
  headers?: string[] | null;
  sample_rows: string[][];
  total_sampled: number;
}

export type TabKind =
  | "query"
  | "table-data"
  | "designer"
  | "welcome"
  | "er"
  | "redis-key";

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  connectionId?: string;
  schema?: string;
  table?: string;
  subtitle?: string;
  dirty?: boolean;
  // Set when kind === "redis-key": the raw key name and its Redis value type
  // (string/hash/list/set/zset/stream/ReJSON-RL/...).
  redisKey?: string;
  redisType?: string;
}
