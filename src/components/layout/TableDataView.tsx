import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Filter as FilterIcon,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import type {
  ColumnInfo,
  Edit,
  EditBatch,
  Filter,
  OrderBy,
  TableQuery,
  WorkspaceTab,
} from "@/types";
import { api } from "@/lib/api";
import {
  TableDataGrid,
  type GridRow,
} from "@/components/data/TableDataGrid";
import { FilterBuilder } from "@/components/data/FilterBuilder";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useT } from "@/store/i18n";
import { toast } from "@/store/toasts";

const PAGE_SIZE = 100;

type Pending =
  | { kind: "update"; rowKey: string; pk: Record<string, unknown>; set: Record<string, unknown> }
  | { kind: "insert"; rowKey: string; values: Record<string, unknown> }
  | { kind: "delete"; rowKey: string; pk: Record<string, unknown> };

function rowKeyOf(
  pkCols: ColumnInfo[],
  rowIndex: number,
  values: unknown[],
  columns: ColumnInfo[]
) {
  if (pkCols.length === 0) return `row:${rowIndex}`;
  return pkCols
    .map((pk) => {
      const idx = columns.findIndex((c) => c.name === pk.name);
      return `${pk.name}=${JSON.stringify(values[idx] ?? null)}`;
    })
    .join("|");
}

export function TableDataView({ tab }: { tab: WorkspaceTab }) {
  const connectionId = tab.connectionId!;
  const schema = tab.schema;
  const table = tab.table ?? tab.title;

  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [order, setOrder] = useState<OrderBy | undefined>();
  const [filters, setFilters] = useState<Filter[]>([]);
  const [whereRaw, setWhereRaw] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const [pending, setPending] = useState<Map<string, Pending>>(new Map());
  const [showFilter, setShowFilter] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const t = useT();

  const pkCols = useMemo(() => columns.filter((c) => c.is_primary_key), [columns]);
  // Row identity columns: PK if present, else fall back to every column.
  const identCols = pkCols.length > 0 ? pkCols : columns;
  const editable = columns.length > 0;
  const hasPk = pkCols.length > 0;

  const makeQuery = useCallback(
    (offset: number): TableQuery => ({
      schema,
      table,
      limit: PAGE_SIZE,
      offset,
      order_by: order,
      filters,
      where_raw: whereRaw || undefined,
    }),
    [schema, table, order, filters, whereRaw]
  );

  const load = useCallback(
    async (nextPage: number, forceCols = false) => {
      setLoading(true);
      setError(null);
      try {
        const needCols = forceCols || columns.length === 0;
        const [pkInfo, result, total] = await Promise.all([
          needCols
            ? api
                .listColumns(connectionId, table, schema)
                .catch((e) => {
                  // Column metadata is non-fatal — the grid still works with
                  // just what the SELECT returned, but warn the user that
                  // PK/nullable hints are missing.
                  toast.error(
                    "Couldn't load column metadata",
                    String(e)
                  );
                  return [] as ColumnInfo[];
                })
            : Promise.resolve([] as ColumnInfo[]),
          api.fetchTableData(connectionId, makeQuery(nextPage * PAGE_SIZE)),
          api.countTableRows(connectionId, makeQuery(0)).catch((e) => {
            // Row count is informational; surface the failure as a toast but
            // don't block the data fetch.
            toast.error("Couldn't count rows", String(e));
            return null;
          }),
        ]);
        // The grid MUST use the columns that came back with SELECT * so the
        // positional mapping of row values stays in sync. Enrich with PK / nullable
        // metadata from list_columns where names match.
        if (needCols) {
          const merged: ColumnInfo[] = result.columns.map((rc) => {
            const meta = pkInfo.find((p) => p.name === rc.name);
            return {
              name: rc.name,
              data_type: meta?.data_type ?? rc.data_type,
              nullable: meta?.nullable ?? true,
              is_primary_key: meta?.is_primary_key ?? false,
              default_value: meta?.default_value ?? null,
            };
          });
          setColumns(merged);
        }
        setRows(result.rows);
        setElapsed(result.elapsed_ms);
        setRowCount(total);
        setPage(nextPage);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [connectionId, table, schema, columns, makeQuery]
  );

  const hardRefresh = useCallback(() => {
    void load(page, true);
  }, [load, page]);

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, table, schema, order, JSON.stringify(filters), whereRaw]);

  const gridRows: GridRow[] = useMemo(() => {
    const base: GridRow[] = rows.map((vals, idx) => {
      const key = rowKeyOf(pkCols, idx, vals, columns);
      const pend = pending.get(key);
      if (pend?.kind === "delete") {
        return {
          key,
          values: vals,
          kind: "existing",
          deleted: true,
          originalValues: vals,
        };
      }
      if (pend?.kind === "update") {
        const edited = vals.slice();
        const dirty = new Set<number>();
        for (const [col, v] of Object.entries(pend.set)) {
          const i = columns.findIndex((c) => c.name === col);
          if (i >= 0) {
            edited[i] = v;
            dirty.add(i);
          }
        }
        return {
          key,
          values: edited,
          kind: "existing",
          dirtyCols: dirty,
          originalValues: vals,
        };
      }
      return { key, values: vals, kind: "existing", originalValues: vals };
    });

    // Prepend inserts so they're visible without scrolling
    const inserts: GridRow[] = [];
    for (const p of pending.values()) {
      if (p.kind !== "insert") continue;
      const vals = columns.map((c) => (p.values[c.name] ?? null) as unknown);
      inserts.push({
        key: p.rowKey,
        values: vals,
        kind: "insert",
        dirtyCols: new Set(columns.map((_, i) => i)),
      });
    }
    return [...inserts, ...base];
  }, [rows, columns, pending, pkCols]);

  const onSortClick = (col: string) => {
    setOrder((o) => {
      if (!o || o.column !== col) return { column: col, direction: "asc" };
      if (o.direction === "asc") return { column: col, direction: "desc" };
      return undefined;
    });
  };

  const applyFilter = (next: Filter[], nextRaw: string) => {
    setFilters(next);
    setWhereRaw(nextRaw);
  };

  const onCellEdit = (rowKey: string, colIndex: number, value: unknown) => {
    const col = columns[colIndex];
    if (!col) return;
    setPending((prev) => {
      const next = new Map(prev);
      const existing = next.get(rowKey);
      if (existing?.kind === "insert") {
        next.set(rowKey, {
          ...existing,
          values: { ...existing.values, [col.name]: value },
        });
        return next;
      }
      // Build PK map from rows
      const idx = gridRows.findIndex((r) => r.key === rowKey);
      if (idx < 0) return prev;
      const origVals = gridRows[idx].originalValues ?? gridRows[idx].values;
      const pk: Record<string, unknown> = {};
      for (const p of identCols) {
        const i = columns.findIndex((c) => c.name === p.name);
        pk[p.name] = origVals[i];
      }
      // If value matches original, drop the change from the set
      const origIdx = columns.findIndex((c) => c.name === col.name);
      const originalValue = origVals[origIdx];
      const set: Record<string, unknown> = {
        ...(existing?.kind === "update" ? existing.set : {}),
      };
      if (deepEq(value, originalValue)) {
        delete set[col.name];
      } else {
        set[col.name] = value;
      }
      if (Object.keys(set).length === 0) {
        next.delete(rowKey);
      } else {
        next.set(rowKey, { kind: "update", rowKey, pk, set });
      }
      return next;
    });
  };

  const onRowRevert = (rowKey: string) => {
    setPending((prev) => {
      const next = new Map(prev);
      next.delete(rowKey);
      return next;
    });
  };

  const onRowDelete = (rowKey: string) => {
    setPending((prev) => {
      const next = new Map(prev);
      const existing = next.get(rowKey);
      if (existing?.kind === "insert") {
        next.delete(rowKey);
        return next;
      }
      if (existing?.kind === "delete") {
        next.delete(rowKey);
        return next;
      }
      const idx = gridRows.findIndex((r) => r.key === rowKey);
      if (idx < 0) return prev;
      const origVals = gridRows[idx].originalValues ?? gridRows[idx].values;
      const pk: Record<string, unknown> = {};
      for (const p of identCols) {
        const i = columns.findIndex((c) => c.name === p.name);
        pk[p.name] = origVals[i];
      }
      next.set(rowKey, { kind: "delete", rowKey, pk });
      return next;
    });
  };

  const onAddRow = () => {
    const key = `insert:${crypto.randomUUID()}`;
    setPending((prev) => {
      const next = new Map(prev);
      next.set(key, { kind: "insert", rowKey: key, values: {} });
      return next;
    });
  };

  const buildBatch = (): EditBatch => ({
    schema,
    table,
    edits: Array.from(pending.values()).map<Edit>((p) => {
      if (p.kind === "update")
        return {
          kind: "update",
          pk: Object.entries(p.pk),
          set: Object.entries(p.set),
        };
      if (p.kind === "insert")
        return {
          kind: "insert",
          values: Object.entries(p.values),
        };
      return {
        kind: "delete",
        pk: Object.entries(p.pk),
      };
    }),
  });

  const openPreview = async () => {
    const batch = buildBatch();
    if (batch.edits.length === 0) return;
    try {
      const sql = await api.previewEdits(connectionId, batch);
      setPreview(sql);
      setPreviewOpen(true);
    } catch (e) {
      setApplyError(String(e));
    }
  };

  const apply = async () => {
    const batch = buildBatch();
    if (batch.edits.length === 0) return;
    setApplying(true);
    setApplyError(null);
    try {
      const r = await api.applyEdits(connectionId, batch);
      if (!r.ok) {
        setApplyError(r.error ?? `Failed at edit #${(r.failed_at ?? 0) + 1}`);
        return;
      }
      setPending(new Map());
      setPreviewOpen(false);
      await load(page);
    } catch (e) {
      setApplyError(String(e));
    } finally {
      setApplying(false);
    }
  };

  const pendingCount = pending.size;
  const totalPages = rowCount != null ? Math.max(1, Math.ceil(rowCount / PAGE_SIZE)) : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-surface/30 px-3">
        <ToolbarBtn onClick={hardRefresh} icon={RefreshCw} label={t("table.toolbar.refresh")} />
        <ToolbarBtn
          onClick={() => setShowFilter((v) => !v)}
          icon={FilterIcon}
          label={t("table.toolbar.filter")}
          active={showFilter || filters.length > 0 || !!whereRaw}
        />
        <div className="mx-2 h-4 w-px bg-border" />
        <ToolbarBtn
          onClick={onAddRow}
          icon={Plus}
          label={t("table.toolbar.add_row")}
          disabled={!editable}
        />
        {!hasPk && columns.length > 0 && (
          <span
            className="ml-1 rounded bg-warning/20 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wider text-warning"
            title={t("table.toolbar.no_pk_title")}
          >
            {t("table.toolbar.no_pk")}
          </span>
        )}
        <div className="flex-1" />
        <div className="text-[12px] text-muted-foreground">
          {tab.title}
          {order && (
            <>
              {" · "}{t("table.footer.sort")}{" "}
              <span className="text-foreground/70">
                {order.column} {order.direction}
              </span>
            </>
          )}
          {elapsed != null && <> · {elapsed}ms</>}
        </div>
      </div>

      {showFilter && (
        <FilterBuilder
          columns={columns}
          filters={filters}
          whereRaw={whereRaw}
          onApply={applyFilter}
          onClose={() => setShowFilter(false)}
        />
      )}

      <div className="min-h-0 flex-1">
        {error ? (
          <ErrorBanner message={error} />
        ) : loading && rows.length === 0 ? (
          <LoadingState />
        ) : (
          <TableDataGrid
            columns={columns}
            rows={gridRows}
            order={order}
            editable={editable}
            onSortClick={onSortClick}
            onCellEdit={onCellEdit}
            onRowRevert={onRowRevert}
            onRowDelete={onRowDelete}
          />
        )}
      </div>

      <footer className="flex h-9 shrink-0 items-center gap-3 overflow-hidden whitespace-nowrap border-t border-border/70 bg-surface/50 px-3 text-[11.5px] text-muted-foreground">
        <Pager
          page={page}
          totalPages={totalPages}
          rowCount={rowCount}
          onPrev={() => page > 0 && void load(page - 1)}
          onNext={() => (totalPages == null || page < totalPages - 1) && void load(page + 1)}
        />
        <div className="flex-1" />
        {applyError && (
          <button
            onClick={() => setPreviewOpen(true)}
            title={applyError}
            className="flex min-w-0 items-center gap-1.5 text-danger hover:underline"
          >
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="min-w-0 truncate">{applyError}</span>
          </button>
        )}
        {pendingCount > 0 && (
          <>
            <span className="shrink-0 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-400">
              {t("table.footer.pending", { n: pendingCount })}
            </span>
            <button
              onClick={() => setPending(new Map())}
              className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <Undo2 className="h-3 w-3" />
              {t("common.revert")}
            </button>
            <button
              onClick={openPreview}
              className="flex h-6 shrink-0 items-center gap-1 rounded border border-border px-2 hover:bg-accent"
            >
              {t("common.preview")}
            </button>
            <button
              onClick={apply}
              disabled={applying}
              className="flex h-6 shrink-0 items-center gap-1 rounded bg-brand px-2 font-medium text-brand-foreground hover:bg-brand/90 disabled:opacity-60"
            >
              <Check className="h-3 w-3" />
              {applying ? t("common.applying") : t("common.apply")}
            </button>
          </>
        )}
      </footer>

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={t("table.preview.title")}
        width={720}
        footer={
          <>
            <div className="mr-auto text-[12px] text-muted-foreground">
              {t("table.preview.summary", { n: pendingCount })}
            </div>
            <Button variant="ghost" onClick={() => setPreviewOpen(false)}>
              {t("common.close")}
            </Button>
            <Button variant="primary" onClick={apply} disabled={applying}>
              {applying ? t("common.applying") : t("common.apply")}
            </Button>
          </>
        }
      >
        <div className="space-y-2 font-mono text-[12.5px]">
          {preview?.map((s, i) => (
            <pre
              key={i}
              className="overflow-auto rounded-md border border-border/70 bg-surface-muted/40 p-3 text-foreground/90"
            >
              {s};
            </pre>
          ))}
          {applyError && (
            <div className="rounded-md border border-danger/40 bg-danger/10 p-3 text-danger">
              {applyError}
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
}

function ToolbarBtn({
  icon: Icon,
  label,
  onClick,
  disabled,
  title,
  active,
}: {
  icon: React.ElementType;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  active?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px]",
        disabled
          ? "text-muted-foreground/40"
          : active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function Pager({
  page,
  totalPages,
  rowCount,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number | null;
  rowCount: number | null;
  onPrev: () => void;
  onNext: () => void;
}) {
  const start = page * PAGE_SIZE + 1;
  const end = rowCount != null ? Math.min((page + 1) * PAGE_SIZE, rowCount) : "?";
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onPrev}
        disabled={page === 0}
        className="grid h-6 w-6 place-items-center rounded hover:bg-accent disabled:opacity-40"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span>
        {rowCount != null && rowCount > 0 ? (
          <>
            {start}–{end} of{" "}
            <span className="tabular-nums text-foreground/80">
              {rowCount.toLocaleString()}
            </span>
          </>
        ) : (
          "—"
        )}
      </span>
      <button
        onClick={onNext}
        disabled={totalPages != null && page >= totalPages - 1}
        className="grid h-6 w-6 place-items-center rounded hover:bg-accent disabled:opacity-40"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      {totalPages != null && (
        <span className="text-muted-foreground/70">
          page {page + 1} / {totalPages}
        </span>
      )}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex h-full items-start justify-center p-6">
      <div className="max-w-lg rounded-lg border border-danger/40 bg-danger/10 p-4 text-[12.5px]">
        <div className="mb-1 flex items-center gap-2 font-medium text-danger">
          <AlertTriangle className="h-4 w-4" />
          {useT()("table.err.load")}
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[12px] text-foreground/90">
          {message}
        </pre>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-1 p-3">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className="h-6 animate-pulse rounded bg-surface-muted/50"
          style={{ opacity: 1 - i * 0.06 }}
        />
      ))}
    </div>
  );
}

function deepEq(a: unknown, b: unknown) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) {
    return String(a) === String(b);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
