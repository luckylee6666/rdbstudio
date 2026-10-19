import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import { ToolCard, ToolField, ToolSelect } from "@/components/tools/ToolKit";
import { toast } from "@/store/toasts";
import { useT } from "@/store/i18n";
import type { SchemaObject } from "@/components/connection/SchemaObjectTree";

export interface SequenceOptions {
  schema: string;
  name: string;
  data_type: string;
  start: string;
  increment: string;
  min: string;
  max: string;
  cache: string;
  cycle: boolean;
}

interface SequenceCatalog {
  objects: SchemaObject[];
  truncated: boolean;
}

const DATA_TYPES = ["smallint", "integer", "bigint"];
const TYPE_MAX: Record<string, string> = {
  smallint: "32767",
  integer: "2147483647",
  bigint: "9223372036854775807",
};

function emptyOptions(schema?: string | null): SequenceOptions {
  return {
    schema: schema ?? "public",
    name: "",
    data_type: "bigint",
    start: "1",
    increment: "1",
    min: "1",
    max: TYPE_MAX.bigint,
    cache: "1",
    cycle: false,
  };
}

function validInteger(value: string): boolean {
  return /^-?\d+$/.test(value.trim());
}

export function SequenceManager({
  connectionId,
  schema,
  readOnly = false,
  initialName,
}: {
  connectionId: string;
  schema?: string | null;
  readOnly?: boolean;
  initialName?: string;
}) {
  const t = useT();
  const targetKey = `${connectionId}\u0000${schema ?? ""}\u0000${initialName ?? ""}`;
  const targetRef = useRef(targetKey);
  targetRef.current = targetKey;
  const generationRef = useRef(0);
  const [sequences, setSequences] = useState<SchemaObject[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selectedName, setSelectedName] = useState(initialName ?? "");
  const [creating, setCreating] = useState(false);
  const [options, setOptions] = useState<SequenceOptions | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [restartEnabled, setRestartEnabled] = useState(false);
  const [restartValue, setRestartValue] = useState("1");
  const [restartConfirm, setRestartConfirm] = useState(false);
  const [dropConfirm, setDropConfirm] = useState(false);

  const current = (target: string, generation: number) =>
    targetRef.current === target && generationRef.current === generation;
  const nextGeneration = () => ++generationRef.current;

  async function loadCatalog(target: string, generation: number, selectName?: string) {
    const catalog = await invoke<SequenceCatalog>("list_schema_objects", {
      id: connectionId,
      schema: schema ?? null,
    });
    if (!current(target, generation)) return;
    const entries = catalog.objects.filter((object) => object.kind === "sequence");
    setSequences(entries);
    setTruncated(catalog.truncated);
    if (selectName) {
      const item = entries.find((object) => object.name === selectName);
      if (!item) {
        setSelectedName(selectName);
        setOptions(null);
        setError(t("sequence.missing"));
        return;
      }
      const nextOptions = await invoke<SequenceOptions>("get_sequence_options", {
        id: connectionId,
        schema: item.schema ?? schema ?? "",
        name: item.name,
      });
      if (!current(target, generation)) return;
      setSelectedName(item.name);
      setOptions(nextOptions);
      setCreating(false);
    }
  }

  useEffect(() => {
    const target = targetKey;
    const generation = nextGeneration();
    setSequences([]);
    setTruncated(false);
    setSelectedName(initialName ?? "");
    setCreating(false);
    setOptions(null);
    setError("");
    setRestartEnabled(false);
    setRestartValue("1");
    setRestartConfirm(false);
    setDropConfirm(false);
    setBusy(true);
    void loadCatalog(target, generation, initialName)
      .catch((cause) => {
        if (current(target, generation)) setError(String(cause));
      })
      .finally(() => {
        if (current(target, generation)) setBusy(false);
      });
    // Props define the object target; loadCatalog intentionally captures this request generation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const beginCreate = () => {
    nextGeneration();
    setSelectedName("");
    setOptions(emptyOptions(schema));
    setCreating(true);
    setError("");
    setRestartEnabled(false);
    setRestartValue("1");
  };

  const selectSequence = async (item: SchemaObject) => {
    if (busy) return;
    const target = targetRef.current;
    const generation = nextGeneration();
    setBusy(true);
    setSelectedName(item.name);
    setCreating(false);
    setOptions(null);
    setError("");
    try {
      const next = await invoke<SequenceOptions>("get_sequence_options", {
        id: connectionId,
        schema: item.schema ?? schema ?? "",
        name: item.name,
      });
      if (!current(target, generation)) return;
      setOptions(next);
      setRestartEnabled(false);
      setRestartValue(next.start);
    } catch (cause) {
      if (current(target, generation)) setError(String(cause));
    } finally {
      if (current(target, generation)) setBusy(false);
    }
  };

  const refresh = async (selectName = selectedName || undefined) => {
    if (busy) return;
    const target = targetRef.current;
    const generation = nextGeneration();
    setBusy(true);
    setError("");
    try {
      await loadCatalog(target, generation, selectName);
    } catch (cause) {
      if (current(target, generation)) setError(String(cause));
    } finally {
      if (current(target, generation)) setBusy(false);
    }
  };

  const validate = (value: SequenceOptions, restart: string | null) => {
    if (!value.schema.trim() || !value.name.trim()) {
      setError(t("sequence.required"));
      return false;
    }
    if (![value.start, value.increment, value.min, value.max, value.cache].every(validInteger) ||
      (restart !== null && !validInteger(restart))) {
      setError(t("sequence.integer_required"));
      return false;
    }
    return true;
  };

  const persist = async (confirmedRestart: boolean) => {
    if (!options || readOnly || busy) return;
    const restart = !creating && restartEnabled && confirmedRestart ? restartValue.trim() : null;
    if (!validate(options, restart)) return;
    const target = targetRef.current;
    const generation = nextGeneration();
    const create = creating;
    const payload: SequenceOptions = {
      ...options,
      schema: create ? options.schema.trim() : options.schema,
      name: create ? options.name.trim() : options.name,
      start: options.start.trim(),
      increment: options.increment.trim(),
      min: options.min.trim(),
      max: options.max.trim(),
      cache: options.cache.trim(),
    };
    setBusy(true);
    setError("");
    try {
      await invoke("save_sequence", {
        id: connectionId,
        options: payload,
        create,
        restart,
      });
      if (!current(target, generation)) return;
      toast.success(t(create ? "sequence.created" : "sequence.saved"));
      setCreating(false);
      setSelectedName(payload.name);
      setOptions(payload);
      setRestartEnabled(false);
      await loadCatalog(target, generation, payload.name);
    } catch (cause) {
      if (current(target, generation)) setError(String(cause));
    } finally {
      if (current(target, generation)) setBusy(false);
    }
  };

  const requestSave = () => {
    if (!options || busy || readOnly) return;
    const restart = !creating && restartEnabled ? restartValue.trim() : null;
    if (!validate(options, restart)) return;
    if (restart !== null) setRestartConfirm(true);
    else void persist(false);
  };

  const drop = async () => {
    if (!options || creating || readOnly || busy) return;
    const target = targetRef.current;
    const generation = nextGeneration();
    setBusy(true);
    setError("");
    try {
      await invoke("drop_sequence", {
        id: connectionId,
        schema: options.schema,
        name: options.name,
      });
      if (!current(target, generation)) return;
      toast.success(t("sequence.dropped"));
      setOptions(null);
      setSelectedName("");
      await loadCatalog(target, generation);
    } catch (cause) {
      if (current(target, generation)) setError(String(cause));
    } finally {
      if (current(target, generation)) setBusy(false);
    }
  };

  const setField = <K extends keyof SequenceOptions>(key: K, value: SequenceOptions[K]) => {
    setOptions((old) => old ? { ...old, [key]: value } : old);
  };
  const inputDisabled = busy || readOnly;

  return (
    <div className="object-tool flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-surface/30 px-3 py-1">
        <span className="text-[12px] font-medium text-foreground">{t("sequence.title")}</span>
        {readOnly && <span className="rounded-md bg-warning/15 px-2 py-0.5 text-[11px] text-warning">{t("sequence.read_only")}</span>}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy} aria-label={t("common.refresh")}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {t("common.refresh")}
        </Button>
        <Button size="sm" onClick={beginCreate} disabled={busy || readOnly}>
          <Plus className="h-3.5 w-3.5" />{t("sequence.new")}
        </Button>
      </div>

      <div className="object-tool-layout min-h-0 flex-1">
        <aside className="min-h-0 overflow-auto border-r border-border/70 bg-surface/20 p-2">
          {sequences.map((item) => (
            <button
              key={`${item.schema ?? ""}.${item.name}`}
              type="button"
              disabled={busy}
              aria-current={selectedName === item.name && !creating ? "true" : undefined}
              onClick={() => void selectSequence(item)}
              className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] disabled:opacity-50 ${selectedName === item.name && !creating ? "bg-brand/15 text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
            >
              <RotateCcw className="h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.schema && <span className="max-w-20 truncate text-[10px] text-muted-foreground/70">{item.schema}</span>}
            </button>
          ))}
          {!busy && sequences.length === 0 && <p className="px-2 py-3 text-[12px] text-muted-foreground">{t("sequence.empty")}</p>}
          {truncated && <p className="px-2 py-2 text-[11px] text-warning">{t("sequence.truncated")}</p>}
        </aside>

        <main className="min-h-0 overflow-auto p-4">
          {error && <p role="alert" className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">{error}</p>}
          {options ? (
            <ToolCard
              title={creating ? t("sequence.create_title") : t("sequence.details")}
              aside={!creating && !readOnly ? <Button size="sm" variant="danger" onClick={() => setDropConfirm(true)} disabled={busy}><Trash2 className="h-3.5 w-3.5" />{t("sequence.drop")}</Button> : undefined}
            >
              <div className="object-tool-fields gap-3">
                <ToolField label={t("sequence.schema")}>
                  <Input aria-label={t("sequence.schema")} value={options.schema} readOnly disabled={inputDisabled} />
                </ToolField>
                <ToolField label={t("sequence.name")}>
                  <Input aria-label={t("sequence.name")} value={options.name} disabled={inputDisabled || !creating} onChange={(event) => setField("name", event.target.value)} />
                </ToolField>
                <ToolField label={t("sequence.data_type")}>
                  <ToolSelect aria-label={t("sequence.data_type")} value={options.data_type} disabled={inputDisabled} onChange={(event) => {
                    const dataType = event.target.value;
                    setOptions((old) => old ? { ...old, data_type: dataType, min: "1", max: TYPE_MAX[dataType] ?? old.max } : old);
                  }}>
                    {DATA_TYPES.map((dataType) => <option key={dataType} value={dataType}>{dataType}</option>)}
                  </ToolSelect>
                </ToolField>
                <ToolField label={t("sequence.start")}>
                  <Input aria-label={t("sequence.start")} inputMode="numeric" value={options.start} disabled={inputDisabled} onChange={(event) => setField("start", event.target.value)} />
                </ToolField>
                <ToolField label={t("sequence.increment")}>
                  <Input aria-label={t("sequence.increment")} inputMode="numeric" value={options.increment} disabled={inputDisabled} onChange={(event) => setField("increment", event.target.value)} />
                </ToolField>
                <ToolField label={t("sequence.min")}>
                  <Input aria-label={t("sequence.min")} inputMode="numeric" value={options.min} disabled={inputDisabled} onChange={(event) => setField("min", event.target.value)} />
                </ToolField>
                <ToolField label={t("sequence.max")}>
                  <Input aria-label={t("sequence.max")} inputMode="numeric" value={options.max} disabled={inputDisabled} onChange={(event) => setField("max", event.target.value)} />
                </ToolField>
                <ToolField label={t("sequence.cache")}>
                  <Input aria-label={t("sequence.cache")} inputMode="numeric" value={options.cache} disabled={inputDisabled} onChange={(event) => setField("cache", event.target.value)} />
                </ToolField>
                <div className="flex items-end pb-1">
                  <button type="button" role="switch" aria-checked={options.cycle} disabled={inputDisabled}
                    onClick={() => setField("cycle", !options.cycle)}
                    className="flex items-center gap-2 rounded-md px-1 py-2 text-[12px] text-foreground/90 disabled:opacity-50">
                    <span className={`grid h-4 w-4 place-items-center rounded border ${options.cycle ? "border-brand bg-brand text-brand-foreground" : "border-border bg-background"}`}>
                      {options.cycle && <Check className="h-3 w-3" />}
                    </span>
                    {t("sequence.cycle")}
                  </button>
                </div>
              </div>

              {!creating && !readOnly && (
                <div className="mt-4 rounded-lg border border-border/60 bg-background/30 p-3">
                  <button type="button" role="switch" aria-checked={restartEnabled} disabled={busy}
                    onClick={() => setRestartEnabled((value) => !value)}
                    className="flex items-center gap-2 text-[12px] text-foreground/90 disabled:opacity-50">
                    <span className={`grid h-4 w-4 place-items-center rounded border ${restartEnabled ? "border-brand bg-brand text-brand-foreground" : "border-border bg-background"}`}>
                      {restartEnabled && <Check className="h-3 w-3" />}
                    </span>
                    {t("sequence.restart")}
                  </button>
                  {restartEnabled && <div className="mt-3 max-w-xs"><ToolField label={t("sequence.restart_value")}>
                    <Input aria-label={t("sequence.restart_value")} inputMode="numeric" value={restartValue} disabled={busy} onChange={(event) => setRestartValue(event.target.value)} />
                  </ToolField></div>}
                </div>
              )}

              <div className="mt-4 flex items-center justify-end gap-2">
                <Button variant="primary" onClick={requestSave} disabled={busy || readOnly}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {creating ? t("sequence.create") : t("sequence.save")}
                </Button>
              </div>
            </ToolCard>
          ) : !busy && !error ? (
            <div className="flex h-full min-h-[180px] items-center justify-center text-[12px] text-muted-foreground">{t("sequence.select_hint")}</div>
          ) : null}
        </main>
      </div>

      <ConfirmDialog open={restartConfirm} title={t("sequence.restart_title")} message={t("sequence.restart_warning")}
        confirmLabel={t("sequence.restart_confirm")} cancelLabel={t("common.cancel")} danger
        onConfirm={() => { setRestartConfirm(false); void persist(true); }} onClose={() => setRestartConfirm(false)} />
      <ConfirmDialog open={dropConfirm} title={t("sequence.drop_title")} message={t("sequence.drop_warning", { name: options?.name ?? selectedName })}
        confirmLabel={t("sequence.drop")} cancelLabel={t("common.cancel")} danger
        onConfirm={() => { setDropConfirm(false); void drop(); }} onClose={() => setDropConfirm(false)} />
    </div>
  );
}
