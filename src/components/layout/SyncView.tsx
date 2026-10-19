import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, ArrowRight, ArrowRightLeft, CheckCircle2, RefreshCw, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { cn } from "@/lib/cn";
import {
  ConnectionPicker,
  SchemaPicker,
  ToolCard,
  ToolField,
  ToolPage,
  ToolSelect,
  useDefaultConnection,
} from "@/components/tools/ToolKit";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { syncApi } from "@/lib/sync-api";
import { useConnections } from "@/store/connections";
import { useI18n } from "@/store/i18n";
import type { ConnectionConfig, TreeEntry } from "@/types";

const acceptSql = (c: ConnectionConfig) => c.driver !== "redis";
const CUSTOM_TABLE = "\u0000custom";
/** Changes that are reported for review but never block the transfer. */
const INFO_KINDS = new Set(["not_copied", "foreign_keys_not_copied", "checks_not_copied", "index_not_copied", "target_only_column"]);
import type { ConflictPolicy, SyncPreview, SyncRequest } from "@/types/sync";
import { changeLabel, syncText } from "./syncI18n";

export function SyncView() {
  const connections = useConnections((s) => s.list);
  const statuses = useConnections((s) => s.status);
  const lang = useI18n((s) => s.lang);
  const t = (key: Parameters<typeof syncText>[1]) => syncText(lang, key);
  const sqlConnections = useMemo(
    () => connections.filter((c) => c.driver !== "redis"),
    [connections]
  );
  const [sourceId, setSourceId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [sourceSchema, setSourceSchema] = useState("");
  const [targetSchema, setTargetSchema] = useState("");
  const [sourceTable, setSourceTable] = useState("");
  const [targetTable, setTargetTable] = useState("");
  const [customTarget, setCustomTarget] = useState(false);
  const [sourceTables, setSourceTables] = useState<TreeEntry[]>([]);
  const [targetTables, setTargetTables] = useState<TreeEntry[]>([]);
  const [compareDeletes, setCompareDeletes] = useState(false);
  const [createMissing, setCreateMissing] = useState(false);
  const [policy, setPolicy] = useState<ConflictPolicy>("insert_only");
  const [preview, setPreview] = useState<SyncPreview | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const defaultId = useDefaultConnection(acceptSql);
  useEffect(() => {
    const defaultSourceId = sourceId || defaultId;
    if (!sourceId && defaultSourceId) setSourceId(defaultSourceId);
    if (!targetId && sqlConnections.length > 0) {
      setTargetId(
        sqlConnections.find((c) => c.id !== defaultSourceId && statuses[c.id] === "connected")?.id ??
          defaultSourceId
      );
    }
  }, [sqlConnections, sourceId, targetId, defaultId, statuses]);

  useEffect(() => {
    let cancelled = false;
    if (!sourceId || statuses[sourceId] !== "connected") {
      setSourceTables([]);
      return;
    }
    void invoke<TreeEntry[]>("list_tables", {
      id: sourceId,
      schema: sourceSchema || null,
    }).then((tables) => {
      if (!cancelled) setSourceTables(tables.filter((x) => x.kind === "table"));
    }).catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => { cancelled = true; };
  }, [sourceId, sourceSchema, statuses]);

  useEffect(() => {
    let cancelled = false;
    if (!targetId || statuses[targetId] !== "connected") {
      setTargetTables([]);
      return;
    }
    void invoke<TreeEntry[]>("list_tables", {
      id: targetId,
      schema: targetSchema || null,
    }).then((tables) => {
      if (!cancelled) setTargetTables(tables.filter((x) => x.kind === "table"));
    }).catch((e) => {
      if (!cancelled) setError(String(e));
    });
    return () => { cancelled = true; };
  }, [targetId, targetSchema, statuses]);

  const source = sqlConnections.find((c) => c.id === sourceId);
  const target = sqlConnections.find((c) => c.id === targetId);
  const isConnected = !!source && !!target && statuses[sourceId] === "connected" && statuses[targetId] === "connected";
  const targetHasTable = targetTables.some((x) => x.name === targetTable);
  const canApplyStructure = !!preview?.structure.supported && preview.structure.statements.length > 0;
  const dataBlockedByStructure = !!preview?.structure.target_exists && preview.structure.statements.length > 0;

  function invalidatePreview() {
    setPreview(null);
    setMessage("");
  }

  function request(): SyncRequest {
    return {
      source_id: sourceId,
      target_id: targetId,
      source_schema: sourceSchema || null,
      source_table: sourceTable,
      target_schema: targetSchema || null,
      target_table: targetTable,
      compare_deletes: compareDeletes,
    };
  }

  async function runPreview() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const next = await syncApi.preview(request());
      setPreview(next);
      setPolicy("insert_only");
    } catch (e) {
      setPreview(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyStructure() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await syncApi.applyStructure(preview.token);
      setMessage(`${t("report")}: ${result.structure_statements}`);
      setPreview(null);
      await runPreview();
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function applyData() {
    if (!preview) return;
    if (policy === "mirror" && preview.counts.deletes > 0) {
      setConfirmDelete(true);
      return;
    }
    await performData();
  }

  async function performData() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      const result = await syncApi.applyData(
        preview.token,
        policy,
        createMissing && !targetHasTable
      );
      setMessage(`${t("report")}: +${result.inserted} / ~${result.updated} / -${result.deleted}${result.structure_applied_before_data ? ` · ${t("structureBeforeData")}` : ""}`);
      setPreview(null);
    } catch (e) {
      setError(String(e));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const ready = isConnected && sourceId !== "" && targetId !== "" && !!sourceTable && !!targetTable;
  const sameTable =
    sourceId === targetId && (sourceSchema || "") === (targetSchema || "") && sourceTable === targetTable;
  const newTargetTable = !!sourceTable && !targetTables.some((x) => x.name === sourceTable);

  return (
    <ToolPage icon={ArrowRightLeft} title={t("syncTitle")} description={t("syncDesc")}>
      <div className="mx-auto max-w-5xl space-y-4">
        <div className="grid items-stretch gap-3 md:grid-cols-[1fr_auto_1fr]">
          <ToolCard title={t("source")}>
            <div className="space-y-3">
              <ConnectionPicker
                label={t("connection")}
                value={sourceId}
                accept={acceptSql}
                onChange={(id) => { setSourceId(id); setSourceSchema(""); setSourceTable(""); invalidatePreview(); }}
              />
              <SchemaPicker
                label={t("schema")}
                connectionId={sourceId}
                value={sourceSchema}
                onChange={(v) => { setSourceSchema(v); setSourceTable(""); invalidatePreview(); }}
              />
              <ToolField label={t("sourceTable")}>
                <ToolSelect
                  aria-label={t("sourceTable")}
                  value={sourceTable}
                  disabled={sourceTables.length === 0}
                  onChange={(e) => { setSourceTable(e.target.value); if (!targetTable) setTargetTable(e.target.value); invalidatePreview(); }}
                >
                  <option value="">—</option>
                  {sourceTables.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                </ToolSelect>
              </ToolField>
            </div>
          </ToolCard>
          <div className="hidden items-center justify-center md:flex">
            <div className="grid h-9 w-9 place-items-center rounded-full border border-border/70 bg-surface text-brand shadow-soft">
              <ArrowRight className="h-4 w-4" />
            </div>
          </div>
          <ToolCard title={t("target")}>
            <div className="space-y-3">
              <ConnectionPicker
                label={t("connection")}
                value={targetId}
                accept={acceptSql}
                onChange={(id) => { setTargetId(id); setTargetSchema(""); setTargetTable(""); invalidatePreview(); }}
              />
              <SchemaPicker
                label={t("schema")}
                connectionId={targetId}
                value={targetSchema}
                onChange={(v) => { setTargetSchema(v); invalidatePreview(); }}
              />
              <ToolField label={t("targetTable")}>
                <ToolSelect
                  aria-label={t("targetTable")}
                  value={customTarget ? CUSTOM_TABLE : targetTable}
                  disabled={!sourceTable && targetTables.length === 0}
                  onChange={(e) => {
                    const next = e.target.value;
                    setCustomTarget(next === CUSTOM_TABLE);
                    setTargetTable(next === CUSTOM_TABLE ? "" : next);
                    invalidatePreview();
                  }}
                >
                  <option value="">—</option>
                  {newTargetTable && <option value={sourceTable}>{t("newTableOption")}{sourceTable}</option>}
                  {targetTables.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                  <option value={CUSTOM_TABLE}>{t("customTable")}</option>
                </ToolSelect>
                {customTarget && (
                  <Input
                    aria-label={t("customTableName")}
                    placeholder={t("customTableName")}
                    className="mt-2 font-mono"
                    value={targetTable}
                    onChange={(e) => { setTargetTable(e.target.value.trim()); invalidatePreview(); }}
                  />
                )}
              </ToolField>
              {target?.read_only && (
                <p className="flex items-center gap-1.5 text-[11.5px] text-warning">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />{t("targetReadonly")}
                </p>
              )}
            </div>
          </ToolCard>
        </div>

        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-surface/40 px-4 py-3">
          <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <input type="checkbox" checked={compareDeletes} onChange={(e) => { setCompareDeletes(e.target.checked); invalidatePreview(); }} />
            {t("compareDeletes")}
          </label>
          <div className="flex-1" />
          {!ready && !busy && <span className="text-[11.5px] text-muted-foreground">{t("pickTables")}</span>}
          {sameTable && ready && <span className="text-[11.5px] text-warning">{t("sameTable")}</span>}
          <Button variant="primary" disabled={!ready || sameTable || busy} onClick={() => void runPreview()}>
            {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ScanSearch className="h-3.5 w-3.5" />}
            {t("preview")}
          </Button>
        </div>
        {message && (
          <div role="status" className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-[12px] text-success">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />{message}
          </div>
        )}
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span className="break-all">{`${t("error")}: ${error}`}</span>
          </div>
        )}

        {preview && (
          <div className="grid gap-4 lg:grid-cols-2">
            <ToolCard title={t("structure")}>
              {!preview.structure.target_exists && (
                <p className="mb-2 text-[12px]">
                  <span className="font-mono">{targetTable}</span>
                  <span className="ml-2 rounded bg-brand/15 px-1.5 py-0.5 text-[10.5px] text-brand">{t("newTable")}</span>
                </p>
              )}
              {preview.structure.changes.length === 0 && preview.structure.statements.length === 0 && (
                <p className="flex items-center gap-1.5 text-[12px] text-success"><CheckCircle2 className="h-3.5 w-3.5" />{t("structuresMatch")}</p>
              )}
              {preview.structure.changes.length > 0 && (
                <div className="max-h-72 overflow-auto rounded-lg border border-border/60">
                  {preview.structure.changes.map((c, i) => (
                    <div key={`${c.kind}:${c.name}:${i}`} className="border-b border-border/40 px-2.5 py-1.5 text-[12px] last:border-b-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium",
                            c.supported
                              ? "bg-success/15 text-success"
                              : INFO_KINDS.has(c.kind)
                                ? "bg-warning/15 text-warning"
                                : "bg-danger/15 text-danger"
                          )}
                        >
                          {changeLabel(lang, c.kind)}
                        </span>
                        <span className="min-w-0 truncate font-mono font-medium">{c.name}</span>
                        {(c.source_type || c.target_type) && (
                          <span className="ml-auto flex min-w-0 shrink items-center gap-1 truncate font-mono text-[11px] text-muted-foreground">
                            <span className="truncate">{c.source_type ?? "—"}</span>
                            <ArrowRight className="h-3 w-3 shrink-0" />
                            <span className="truncate text-foreground/80">{c.target_type ?? "—"}</span>
                          </span>
                        )}
                      </div>
                      {c.detail && <div className="mt-0.5 pl-1 text-[11px] text-muted-foreground">{c.detail}</div>}
                    </div>
                  ))}
                </div>
              )}
              {preview.structure.reason && <p className="mt-2 text-[12px] text-danger">{t("unsupported")}: {preview.structure.reason}</p>}
              {preview.structure.statements.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1 text-[11px] font-medium text-muted-foreground">{t("statements")}</div>
                  {preview.structure.statements.map((sql) => (
                    <pre key={sql} className="mt-1 max-h-40 overflow-auto rounded-md border border-border/60 bg-background/60 p-2 font-mono text-[11px] leading-relaxed">{sql}</pre>
                  ))}
                </div>
              )}
              {!preview.structure.ddl_transactional && preview.structure.statements.length > 0 && (
                <p className="mt-2 text-[11.5px] text-warning">{t("mysqlDdl")}</p>
              )}
              {canApplyStructure && !target?.read_only && (
                <Button className="mt-3" disabled={busy} onClick={() => void applyStructure()}>{t("applyStructure")}</Button>
              )}
            </ToolCard>
            <ToolCard title={t("data")}>
              {!preview.data_supported && <p className="mb-2 text-[12px] text-warning">{t("unsupported")}: {preview.data_reason}</p>}
              <div className="grid grid-cols-4 gap-2">
                <Stat label={t("insert")} value={preview.counts.inserts} tone="success" />
                <Stat label={t("update")} value={preview.counts.updates} tone="warning" />
                <Stat label={t("delete")} value={preview.counts.deletes} tone="danger" />
                <Stat label={t("unchanged")} value={preview.counts.unchanged} />
              </div>
              <p className="mt-2 text-[11px] text-muted-foreground">{t("rowsExamined")}: {preview.rows_examined}</p>
              {preview.counts.sample_conflict_keys.length > 0 && (
                <p className="mt-1 break-all text-[11px] text-muted-foreground">{t("conflictKeys")}: {preview.counts.sample_conflict_keys.join(" · ")}</p>
              )}
              <div className="mt-3">
                <ToolField label={t("policy")}>
                  <ToolSelect aria-label={t("policy")} value={policy} onChange={(e) => setPolicy(e.target.value as ConflictPolicy)}>
                    <option value="insert_only">{t("insertOnly")}</option>
                    <option value="overwrite">{t("overwrite")}</option>
                    <option value="mirror" disabled={!compareDeletes}>{t("mirror")}</option>
                  </ToolSelect>
                </ToolField>
              </div>
              {!targetHasTable && (
                <label className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
                  <input type="checkbox" checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)} />{t("createTable")}
                </label>
              )}
              {preview.data_supported && !dataBlockedByStructure && !target?.read_only && (
                <Button variant="primary" className="mt-3" disabled={busy || (!targetHasTable && !createMissing)} onClick={() => void applyData()}>{t("applyData")}</Button>
              )}
            </ToolCard>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={t("policy")}
        message={`${t("mirrorConfirmPrefix")} ${preview?.counts.deletes ?? 0} ${t("mirrorConfirmSuffix")}`}
        confirmLabel={t("applyData")}
        danger
        onConfirm={() => { setConfirmDelete(false); void performData(); }}
        onClose={() => setConfirmDelete(false)}
      />
    </ToolPage>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" | "warning" | "danger" }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 px-2.5 py-2">
      <div className="truncate text-[10.5px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 font-mono text-[16px] font-semibold tabular-nums",
          value > 0 && tone === "success" && "text-success",
          value > 0 && tone === "warning" && "text-warning",
          value > 0 && tone === "danger" && "text-danger"
        )}
      >
        {value}
      </div>
    </div>
  );
}
