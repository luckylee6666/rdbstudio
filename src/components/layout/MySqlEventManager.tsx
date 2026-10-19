import { useEffect, useRef, useState } from "react";
import { CalendarClock, Check, Loader2, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Field";
import { ToolCard, ToolField, ToolSelect } from "@/components/tools/ToolKit";
import { toast } from "@/store/toasts";
import { useT } from "@/store/i18n";
import type { SchemaObject } from "@/components/connection/SchemaObjectTree";

export type EventSchedule =
  | { kind: "at"; execute_at: string }
  | {
      kind: "every";
      interval_value: string;
      interval_unit: "YEAR" | "QUARTER" | "MONTH" | "WEEK" | "DAY" | "HOUR" | "MINUTE" | "SECOND";
      starts: string | null;
      ends: string | null;
    };

export interface MySqlEventOptions {
  schema: string;
  name: string;
  schedule: EventSchedule;
  body: string;
  comment: string;
  preserve: boolean;
}

export interface EventDetails {
  options: MySqlEventOptions;
  enabled: boolean;
  definer: string;
  time_zone: string;
  scheduler: string;
}

interface EventCatalog {
  objects: SchemaObject[];
  truncated: boolean;
}

const INTERVAL_UNITS: EventSchedule extends infer _T ? Array<Extract<EventSchedule, { kind: "every" }> ["interval_unit"]> : never = [
  "YEAR", "QUARTER", "MONTH", "WEEK", "DAY", "HOUR", "MINUTE", "SECOND",
];
const DATETIME_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function newOptions(schema?: string | null): MySqlEventOptions {
  return {
    schema: schema ?? "",
    name: "",
    schedule: { kind: "every", interval_value: "1", interval_unit: "DAY", starts: null, ends: null },
    body: "SELECT 1",
    comment: "",
    preserve: true,
  };
}

function validInterval(value: string): boolean {
  return /^[1-9]\d*$/.test(value.trim());
}

function validDateTime(value: string): boolean {
  return !value || DATETIME_FORMAT.test(value);
}

export function MySqlEventManager({
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
  const [events, setEvents] = useState<SchemaObject[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [selectedName, setSelectedName] = useState(initialName ?? "");
  const [creating, setCreating] = useState(false);
  const [details, setDetails] = useState<EventDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dropConfirm, setDropConfirm] = useState(false);
  const [enableConfirm, setEnableConfirm] = useState(false);

  const current = (target: string, generation: number) =>
    targetRef.current === target && generationRef.current === generation;
  const nextGeneration = () => ++generationRef.current;

  async function loadCatalog(target: string, generation: number, selectName?: string) {
    const catalog = await invoke<EventCatalog>("list_schema_objects", {
      id: connectionId,
      schema: schema ?? null,
    });
    if (!current(target, generation)) return;
    const entries = catalog.objects.filter((object) => object.kind === "event");
    setEvents(entries);
    setTruncated(catalog.truncated);
    if (!selectName) return;
    const item = entries.find((object) => object.name === selectName);
    if (!item) {
      setSelectedName(selectName);
      setDetails(null);
      setError(t("event.missing"));
      return;
    }
    const next = await invoke<EventDetails>("get_event_options", {
      id: connectionId,
      schema: item.schema ?? schema ?? "",
      name: item.name,
    });
    if (!current(target, generation)) return;
    setSelectedName(item.name);
    setDetails(next);
    setCreating(false);
  }

  useEffect(() => {
    const target = targetKey;
    const generation = nextGeneration();
    setEvents([]);
    setTruncated(false);
    setSelectedName(initialName ?? "");
    setCreating(false);
    setDetails(null);
    setError("");
    setDropConfirm(false);
    setEnableConfirm(false);
    setBusy(true);
    void loadCatalog(target, generation, initialName)
      .catch((cause) => {
        if (current(target, generation)) setError(String(cause));
      })
      .finally(() => {
        if (current(target, generation)) setBusy(false);
      });
    // Props define the connection/schema/object target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const beginCreate = () => {
    nextGeneration();
    setSelectedName("");
    setDetails({
      options: newOptions(schema),
      enabled: false,
      definer: "",
      time_zone: "SYSTEM",
      scheduler: "unknown",
    });
    setCreating(true);
    setError("");
  };

  const selectEvent = async (item: SchemaObject) => {
    if (busy) return;
    const target = targetRef.current;
    const generation = nextGeneration();
    setBusy(true);
    setSelectedName(item.name);
    setDetails(null);
    setCreating(false);
    setError("");
    try {
      const next = await invoke<EventDetails>("get_event_options", {
        id: connectionId,
        schema: item.schema ?? schema ?? "",
        name: item.name,
      });
      if (!current(target, generation)) return;
      setDetails(next);
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

  const setOptions = (patch: Partial<MySqlEventOptions>) => {
    setDetails((old) => old ? { ...old, options: { ...old.options, ...patch } } : old);
  };

  const validate = (options: MySqlEventOptions) => {
    if (!options.schema.trim() || !options.name.trim() || !options.body.trim()) {
      setError(t("event.required"));
      return false;
    }
    if (options.schedule.kind === "at") {
      if (!DATETIME_FORMAT.test(options.schedule.execute_at)) {
        setError(t("event.datetime_invalid"));
        return false;
      }
    } else if (!validInterval(options.schedule.interval_value) ||
      !validDateTime(options.schedule.starts ?? "") || !validDateTime(options.schedule.ends ?? "")) {
      setError(t("event.schedule_invalid"));
      return false;
    }
    return true;
  };

  const persist = async () => {
    if (!details || readOnly || busy || !validate(details.options)) return;
    const target = targetRef.current;
    const generation = nextGeneration();
    const create = creating;
    const options: MySqlEventOptions = {
      ...details.options,
      schema: create ? details.options.schema.trim() : details.options.schema,
      name: create ? details.options.name.trim() : details.options.name,
      schedule: details.options.schedule.kind === "every"
        ? { ...details.options.schedule, interval_value: details.options.schedule.interval_value.trim() }
        : details.options.schedule,
    };
    setBusy(true);
    setError("");
    try {
      await invoke<EventDetails>("save_event", { id: connectionId, options, create });
      if (!current(target, generation)) return;
      toast.success(t(create ? "event.created" : "event.saved"));
      setCreating(false);
      setSelectedName(options.name);
      if (create) setDetails((old) => old ? { ...old, enabled: false } : old);
      await loadCatalog(target, generation, options.name);
    } catch (cause) {
      if (current(target, generation)) setError(String(cause));
    } finally {
      if (current(target, generation)) setBusy(false);
    }
  };

  const changeEnabled = async (enabled: boolean) => {
    if (!details || creating || readOnly || busy) return;
    const target = targetRef.current;
    const generation = nextGeneration();
    setBusy(true);
    setError("");
    try {
      await invoke("set_event_enabled", {
        id: connectionId,
        schema: details.options.schema,
        name: details.options.name,
        enabled,
      });
      if (!current(target, generation)) return;
      setDetails((old) => old ? { ...old, enabled } : old);
      toast.success(t(enabled ? "event.enabled" : "event.disabled"));
    } catch (cause) {
      if (current(target, generation)) setError(String(cause));
    } finally {
      if (current(target, generation)) setBusy(false);
    }
  };

  const drop = async () => {
    if (!details || creating || readOnly || busy) return;
    const target = targetRef.current;
    const generation = nextGeneration();
    setBusy(true);
    setError("");
    try {
      await invoke("drop_event", {
        id: connectionId,
        schema: details.options.schema,
        name: details.options.name,
      });
      if (!current(target, generation)) return;
      toast.success(t("event.dropped"));
      setDetails(null);
      setSelectedName("");
      await loadCatalog(target, generation);
    } catch (cause) {
      if (current(target, generation)) setError(String(cause));
    } finally {
      if (current(target, generation)) setBusy(false);
    }
  };

  const updateSchedule = (patch: Partial<EventSchedule>) => {
    setDetails((old) => {
      if (!old) return old;
      if (old.options.schedule.kind === "at") {
        return { ...old, options: { ...old.options, schedule: { ...old.options.schedule, ...patch } as EventSchedule } };
      }
      return { ...old, options: { ...old.options, schedule: { ...old.options.schedule, ...patch } as EventSchedule } };
    });
  };

  const inputDisabled = busy || readOnly;
  const options = details?.options;

  return (
    <div className="object-tool flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border/70 bg-surface/30 px-3 py-1">
        <span className="text-[12px] font-medium text-foreground">{t("event.title")}</span>
        {readOnly && <span className="rounded-md bg-warning/15 px-2 py-0.5 text-[11px] text-warning">{t("event.read_only")}</span>}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy} aria-label={t("common.refresh")}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}{t("common.refresh")}
        </Button>
        <Button size="sm" onClick={beginCreate} disabled={busy || readOnly}><Plus className="h-3.5 w-3.5" />{t("event.new")}</Button>
      </div>

      <div className="object-tool-layout min-h-0 flex-1">
        <aside className="min-h-0 overflow-auto border-r border-border/70 bg-surface/20 p-2">
          {events.map((item) => (
            <button key={`${item.schema ?? ""}.${item.name}`} type="button" disabled={busy}
              aria-current={selectedName === item.name && !creating ? "true" : undefined}
              onClick={() => void selectEvent(item)}
              className={`mb-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] disabled:opacity-50 ${selectedName === item.name && !creating ? "bg-brand/15 text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}>
              <CalendarClock className="h-3.5 w-3.5 shrink-0 text-brand" />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.schema && <span className="max-w-20 truncate text-[10px] text-muted-foreground/70">{item.schema}</span>}
            </button>
          ))}
          {!busy && events.length === 0 && <p className="px-2 py-3 text-[12px] text-muted-foreground">{t("event.empty")}</p>}
          {truncated && <p className="px-2 py-2 text-[11px] text-warning">{t("event.truncated")}</p>}
        </aside>

        <main className="min-h-0 overflow-auto p-4">
          {error && <p role="alert" className="mb-3 rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12px] text-danger">{error}</p>}
          {options ? (
            <ToolCard title={creating ? t("event.create_title") : t("event.details")}
              aside={!creating && !readOnly ? <div className="flex items-center gap-2">
                <Button size="sm" variant="danger" onClick={() => setDropConfirm(true)} disabled={busy}><Trash2 className="h-3.5 w-3.5" />{t("event.drop")}</Button>
              </div> : undefined}>
              {!creating && details && <div className="mb-4 grid gap-2 rounded-lg border border-border/60 bg-background/30 p-3 text-[11.5px]"
                style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 9rem), 1fr))" }}>
                <div><span className="text-muted-foreground">{t("event.status")}</span><p className={details.enabled ? "text-success" : "text-muted-foreground"}>{t(details.enabled ? "event.enabled_label" : "event.disabled_label")}</p></div>
                <div><span className="text-muted-foreground">{t("event.definer")}</span><p className="truncate text-foreground/90" title={details.definer}>{details.definer || "—"}</p></div>
                <div className="min-w-0"><span className="text-muted-foreground">{t("event.time_zone")}</span><p className="truncate text-foreground/90" title={details.time_zone}>{details.time_zone || "SYSTEM"}</p></div>
                <div><span className="text-muted-foreground">{t("event.scheduler")}</span><p className="text-foreground/90">{details.scheduler || "unknown"}</p></div>
              </div>}

              {!creating && !readOnly && <div className="mb-4 flex flex-wrap items-center gap-2">
                <Button size="sm" variant={details?.enabled ? "secondary" : "primary"} disabled={busy}
                  onClick={() => details?.enabled ? void changeEnabled(false) : setEnableConfirm(true)}>
                  {details?.enabled ? t("event.disable") : t("event.enable")}
                </Button>
                <span className="text-[11px] text-muted-foreground">{t("event.enable_hint")}</span>
              </div>}

              <div className="object-tool-fields gap-3">
                <ToolField label={t("event.schema")}>
                  <Input aria-label={t("event.schema")} value={options.schema} readOnly disabled={inputDisabled} />
                </ToolField>
                <ToolField label={t("event.name")}>
                  <Input aria-label={t("event.name")} value={options.name} disabled={inputDisabled || !creating} onChange={(event) => setOptions({ name: event.target.value })} />
                </ToolField>
                <ToolField label={t("event.schedule_type")}>
                  <ToolSelect aria-label={t("event.schedule_type")} value={options.schedule.kind} disabled={inputDisabled}
                    onChange={(event) => {
                      const schedule: EventSchedule = event.target.value === "at"
                        ? { kind: "at", execute_at: "" }
                        : { kind: "every", interval_value: "1", interval_unit: "DAY", starts: null, ends: null };
                      setOptions({ schedule });
                    }}>
                    <option value="at">{t("event.once")}</option><option value="every">{t("event.repeating")}</option>
                  </ToolSelect>
                </ToolField>
                {options.schedule.kind === "at" ? (
                  <ToolField label={t("event.execute_at")} hint={t("event.time_hint")}>
                    <Input aria-label={t("event.execute_at")} placeholder="YYYY-MM-DD HH:MM:SS" value={options.schedule.execute_at} disabled={inputDisabled}
                      onChange={(event) => updateSchedule({ execute_at: event.target.value })} />
                  </ToolField>
                ) : <>
                  <ToolField label={t("event.interval")}>
                    <Input aria-label={t("event.interval")} inputMode="numeric" value={options.schedule.interval_value} disabled={inputDisabled}
                      onChange={(event) => updateSchedule({ interval_value: event.target.value })} />
                  </ToolField>
                  <ToolField label={t("event.interval_unit")}>
                    <ToolSelect aria-label={t("event.interval_unit")} value={options.schedule.interval_unit} disabled={inputDisabled}
                      onChange={(event) => updateSchedule({ interval_unit: event.target.value as Extract<EventSchedule, { kind: "every" }>["interval_unit"] })}>
                      {INTERVAL_UNITS.map((unit) => <option key={unit} value={unit}>{t(`event.unit.${unit.toLowerCase()}`)}</option>)}
                    </ToolSelect>
                  </ToolField>
                  <ToolField label={t("event.starts")} hint={t("event.time_hint")}>
                    <Input aria-label={t("event.starts")} placeholder="YYYY-MM-DD HH:MM:SS" value={options.schedule.starts ?? ""} disabled={inputDisabled}
                      onChange={(event) => updateSchedule({ starts: event.target.value || null })} />
                  </ToolField>
                  <ToolField label={t("event.ends")} hint={t("event.time_hint")}>
                    <Input aria-label={t("event.ends")} placeholder="YYYY-MM-DD HH:MM:SS" value={options.schedule.ends ?? ""} disabled={inputDisabled}
                      onChange={(event) => updateSchedule({ ends: event.target.value || null })} />
                  </ToolField>
                </>}
                <div className="col-span-full">
                  <ToolField label={t("event.body")} hint={t("event.body_hint")}>
                    <textarea aria-label={t("event.body")} value={options.body} disabled={inputDisabled} rows={6}
                      onChange={(event) => setOptions({ body: event.target.value })}
                      className="w-full resize-y rounded-md border border-border/80 bg-surface px-2.5 py-2 font-mono text-[12px] text-foreground focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60" />
                  </ToolField>
                </div>
                <div className="col-span-full">
                  <ToolField label={t("event.comment")}>
                    <Input aria-label={t("event.comment")} value={options.comment} disabled={inputDisabled} onChange={(event) => setOptions({ comment: event.target.value })} />
                  </ToolField>
                </div>
                <div className="flex items-end pb-1">
                  <button type="button" role="switch" aria-checked={options.preserve} disabled={inputDisabled}
                    onClick={() => setOptions({ preserve: !options.preserve })}
                    className="flex items-center gap-2 rounded-md px-1 py-2 text-[12px] text-foreground/90 disabled:opacity-50">
                    <span className={`grid h-4 w-4 place-items-center rounded border ${options.preserve ? "border-brand bg-brand text-brand-foreground" : "border-border bg-background"}`}>
                      {options.preserve && <Check className="h-3 w-3" />}
                    </span>
                    {t("event.preserve")}
                  </button>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-end">
                <Button variant="primary" onClick={() => void persist()} disabled={busy || readOnly}>
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {creating ? t("event.create") : t("event.save")}
                </Button>
              </div>
            </ToolCard>
          ) : !busy && !error ? (
            <div className="flex h-full min-h-[180px] items-center justify-center text-[12px] text-muted-foreground">{t("event.select_hint")}</div>
          ) : null}
        </main>
      </div>

      <ConfirmDialog open={enableConfirm} title={t("event.enable_title")}
        message={t(details?.scheduler.toUpperCase() === "ON" ? "event.enable_confirm" : "event.enable_scheduler_off", { name: options?.name ?? selectedName })}
        confirmLabel={t("event.enable")} cancelLabel={t("common.cancel")} onConfirm={() => { setEnableConfirm(false); void changeEnabled(true); }} onClose={() => setEnableConfirm(false)} />
      <ConfirmDialog open={dropConfirm} title={t("event.drop_title")} message={t("event.drop_confirm", { name: options?.name ?? selectedName })}
        confirmLabel={t("event.drop")} cancelLabel={t("common.cancel")} danger onConfirm={() => { setDropConfirm(false); void drop(); }} onClose={() => setDropConfirm(false)} />
    </div>
  );
}
