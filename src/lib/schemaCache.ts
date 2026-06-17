// Per-connection cache of { tableName: [columnNames] } used for SQL editor
// autocomplete. describe_schema runs N describe queries per connection, so we
// fetch it once and reuse it across every editor tab. Lives in its own module
// (not the store or a component) so both can import it without a cycle.

const schemaColCache = new Map<string, Record<string, string[]>>();

export function getSchemaColumns(
  connectionId: string
): Record<string, string[]> | undefined {
  return schemaColCache.get(connectionId);
}

export function setSchemaColumns(
  connectionId: string,
  cols: Record<string, string[]>
) {
  schemaColCache.set(connectionId, cols);
}

/** Bust the cache when a connection's schema may have changed (refresh, DDL). */
export function clearSchemaColumns(connectionId: string) {
  schemaColCache.delete(connectionId);
}
