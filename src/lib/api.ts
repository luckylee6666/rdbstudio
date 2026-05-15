import { invoke } from "@tauri-apps/api/core";
import type {
  AlterPlan,
  ColumnInfo,
  ConnectionConfig,
  ConnectionSummary,
  CsvPreview,
  DesignerChange,
  EditBatch,
  EditResult,
  ExportOptions,
  ExportReport,
  ImportCsvOptions,
  ImportReport,
  ScanPage,
  TableDescription,
  TableQuery,
  TreeEntry,
} from "@/types";

export interface QueryColumn {
  name: string;
  data_type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[][];
  rows_affected: number | null;
  elapsed_ms: number;
}

export interface HistoryEntry {
  id: string;
  connection_id: string;
  sql: string;
  elapsed_ms: number;
  row_count: number | null;
  rows_affected: number | null;
  error: string | null;
  at: string;
}

export const api = {
  appVersion: () => invoke<string>("app_version"),

  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig) =>
    invoke<ConnectionConfig>("save_connection", { config }),
  deleteConnection: (id: string) =>
    invoke<boolean>("delete_connection", { id }),
  testConnection: (config: ConnectionConfig) =>
    invoke<string>("test_connection", { config }),

  connect: (id: string) => invoke<ConnectionSummary>("connect", { id }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),
  connectionStatus: (id: string) =>
    invoke<ConnectionSummary>("connection_status", { id }),

  listDatabases: (id: string) => invoke<string[]>("list_databases", { id }),
  listSchemas: (id: string, database?: string) =>
    invoke<string[]>("list_schemas", { id, database: database ?? null }),
  listTables: (id: string, schema?: string) =>
    invoke<TreeEntry[]>("list_tables", { id, schema: schema ?? null }),
  listColumns: (id: string, table: string, schema?: string) =>
    invoke<ColumnInfo[]>("list_columns", { id, table, schema: schema ?? null }),
  scanRedisKeys: (id: string, cursor: number, limit?: number) =>
    invoke<ScanPage>("scan_redis_keys", {
      id,
      cursor,
      limit: limit ?? null,
    }),

  executeQuery: (id: string, sql: string) =>
    invoke<QueryResult>("execute_query", { id, sql }),
  listHistory: (limit?: number) =>
    invoke<HistoryEntry[]>("list_history", { limit: limit ?? null }),
  clearHistory: () => invoke<void>("clear_history"),

  fetchTableData: (id: string, query: TableQuery) =>
    invoke<QueryResult>("fetch_table_data", { id, query }),
  countTableRows: (id: string, query: TableQuery) =>
    invoke<number>("count_table_rows", { id, query }),
  applyEdits: (id: string, batch: EditBatch) =>
    invoke<EditResult>("apply_edits", { id, batch }),
  previewEdits: (id: string, batch: EditBatch) =>
    invoke<string[]>("preview_edits", { id, batch }),

  describeTable: (id: string, table: string, schema?: string) =>
    invoke<TableDescription>("describe_table", {
      id,
      table,
      schema: schema ?? null,
    }),
  showDdl: (id: string, table: string, schema?: string) =>
    invoke<string>("show_ddl", { id, table, schema: schema ?? null }),
  generateAlterDdl: (
    id: string,
    table: string,
    change: DesignerChange,
    schema?: string
  ) =>
    invoke<AlterPlan>("generate_alter_ddl", {
      id,
      table,
      change,
      schema: schema ?? null,
    }),
  applyAlterDdl: (id: string, statements: string[]) =>
    invoke<string[]>("apply_alter_ddl", { id, statements }),
  describeSchema: (id: string, schema?: string, limit?: number) =>
    invoke<TableDescription[]>("describe_schema", {
      id,
      schema: schema ?? null,
      limit: limit ?? null,
    }),

  exportTable: (
    id: string,
    table: string,
    options: ExportOptions,
    schema?: string
  ) =>
    invoke<ExportReport>("export_table", {
      id,
      table,
      options,
      schema: schema ?? null,
    }),
  importCsv: (id: string, options: ImportCsvOptions) =>
    invoke<ImportReport>("import_csv", { id, options }),
  previewCsv: (path: string, delimiter: string, hasHeader: boolean, limit = 5) =>
    invoke<CsvPreview>("preview_csv", {
      path,
      delimiter,
      hasHeader,
      limit,
    }),
  writeTextFile: (path: string, contents: string) =>
    invoke<void>("write_text_file", { path, contents }),
};
