import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ToolSelect } from "@/components/tools/ToolKit";
import { useT } from "@/store/i18n";
import { parameterError, parameterInput, parameterKinds, type ParameterDefault, type ParameterInput, type QueryParameter } from "@/lib/queryParameters";

import { ParameterBatchEditor } from "./ParameterBatchEditor";
import { parameterBatchIssue, type ParameterBatchDraft } from "@/lib/parameterBatch";
import { parameterSets } from "@/lib/parameterBatch";
import { ParameterPresetLibrary } from "./ParameterPresetLibrary";
import { presetDraft, presetMatches, type ParameterPreset, type ParameterPresetContent } from "@/lib/parameterPresets";
import type { DriverKind } from "@/types";

export function QueryParametersDialog({ names, previous, defaults, connectionName, driver, onClose, onRun, onPrepareBatch, onBatchRun, previousBatch }: {
  names: string[]; previous: QueryParameter[]; defaults: ParameterDefault[]; connectionName: string;
  driver?: DriverKind;
  onClose: () => void; onRun: (parameters: QueryParameter[], inputs: ParameterInput[]) => void;
  onPrepareBatch?: () => Promise<string[]>;
  onBatchRun?: (draft: ParameterBatchDraft) => void;
  previousBatch?: ParameterBatchDraft;
}) {
  const t = useT();
  const [inputs, setInputs] = useState(() => names.map(name => parameterInput(name, previous.find(value => value.name === name), defaults.find(value => value.name === name))));
  const [batchMode, setBatchMode] = useState(false);
  const [batchDraft, setBatchDraft] = useState<ParameterBatchDraft | null>(previousBatch ?? null);
  const [preparing, setPreparing] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const prepareBatch = async () => {
    setPreparing(true); setPrepareError(null);
    try {
      const batchNames = await onPrepareBatch?.() ?? names;
      setBatchDraft(old => ({ atomic: old?.atomic ?? true,
        types: Object.fromEntries(batchNames.map(name => [name, old && Object.hasOwn(old.types, name) ? old.types[name] : inputs.find(input => input.name === name)?.kind ?? "text"])),
        rows: (old?.rows ?? [Object.fromEntries(inputs.map(input => [input.name, input.isNull ? null : input.value]))]).map(row => Object.fromEntries(batchNames.map(name => [name, Object.hasOwn(row, name) ? row[name] : ""]))),
      }));
      setBatchMode(true);
    } catch (error) { setPrepareError(String(error)); }
    finally { setPreparing(false); }
  };
  const update = (index: number, patch: Partial<ParameterInput>) => setInputs(old => old.map((value, i) => i === index ? { ...value, ...patch } : value));
  const errors = inputs.map(parameterError);
  const totalBytes = inputs.reduce((n, input) => n + (input.isNull ? 0 : new TextEncoder().encode(input.value).length), 0);
  const tooLarge = totalBytes > 8 * 1024 * 1024;
  const invalid = batchMode ? !batchDraft || !!parameterBatchIssue(batchDraft.rows, batchDraft.types) : errors.some(Boolean) || tooLarge;
  const content: ParameterPresetContent | null = driver ? {
    driver, mode: batchMode ? "batch" : "single", atomic: batchMode ? batchDraft?.atomic ?? true : true,
    parameters: batchMode && batchDraft ? Object.entries(batchDraft.types).map(([name, kind]) => ({ name, kind })) : inputs.map(({ name, kind }) => ({ name, kind })),
    sets: batchMode && batchDraft ? parameterSets(batchDraft.rows, batchDraft.types) : [inputs.map(input => ({ name: input.name, kind: input.kind, value: input.isNull ? null : input.value }))],
  } : null;
  const loadPreset = async (preset: ParameterPreset) => {
    if (!driver || preset.driver !== driver) throw new Error("preset_mismatch");
    if (preset.mode === "batch" && !onBatchRun) throw new Error("preset_batch_unavailable");
    let expected = names;
    if (preset.mode === "batch") {
      try { expected = await onPrepareBatch?.() ?? names; }
      catch { throw new Error("preset_target_changed"); }
    }
    if (!presetMatches(preset, driver, expected)) throw new Error("preset_mismatch");
    const draft = presetDraft(preset);
    if (preset.mode === "batch") { setBatchDraft(draft); setBatchMode(true); }
    else {
      setInputs(names.map(name => parameterInput(name, { name, kind: draft.types[name], value: draft.rows[0][name] })));
      setBatchMode(false);
    }
  };
  return <Modal open onClose={onClose} closeDisabled={presetBusy} title={t("parameters.title")} width={batchMode ? 1020 : 740} footer={<>
    <Button disabled={presetBusy} onClick={onClose}>{t("common.cancel")}</Button>
    <Button variant="primary" disabled={preparing || presetBusy || invalid} onClick={() => batchMode && batchDraft ? onBatchRun?.(batchDraft) : onRun(inputs.map(input => ({ name: input.name, kind: input.kind, value: input.isNull ? null : input.value })), inputs)}>{batchMode ? t("parameters.batch.run", { n: batchDraft?.rows.length ?? 0 }) : t("parameters.run")}</Button>
  </>}>
    <p className="mb-1 break-words text-sm font-medium">{connectionName}</p>
    <p className="mb-4 text-xs text-muted-foreground">{t("parameters.hint")}</p>
    {content && <fieldset disabled={preparing} className="min-w-0"><ParameterPresetLibrary content={content} valuesValid={!invalid} onLoad={loadPreset} onBusy={setPresetBusy} /></fieldset>}
    <fieldset disabled={preparing || presetBusy} className="min-w-0">
    {onBatchRun && <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={t("parameters.batch.mode")}>
      <Button className="aria-pressed:border-brand/40 aria-pressed:bg-brand/10 aria-pressed:text-brand" aria-pressed={!batchMode} disabled={preparing} onClick={() => setBatchMode(false)}>{t("parameters.batch.single")}</Button>
      <Button className="aria-pressed:border-brand/40 aria-pressed:bg-brand/10 aria-pressed:text-brand" aria-pressed={batchMode} disabled={preparing} onClick={() => void prepareBatch()}>{preparing ? t("parameters.batch.preparing") : t("parameters.batch.title")}</Button>
    </div>}
    {prepareError && <p role="alert" className="mb-3 text-xs text-danger">{prepareError}</p>}
    {batchMode && batchDraft ? <ParameterBatchEditor draft={batchDraft} onChange={setBatchDraft} /> : <>

    <div className="space-y-3">{inputs.map((input, index) => <fieldset key={input.name} className="min-w-0 rounded-lg border border-border/70 p-3">
      <legend className="px-1 font-mono text-sm text-brand">:{input.name}</legend>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <ToolSelect className="min-w-[150px] flex-1" aria-label={`${input.name} · ${t("parameters.type")}`} value={input.kind} onChange={e => update(index, { kind: e.target.value as ParameterInput["kind"], ...(e.target.value === "boolean" && !["true", "false"].includes(input.value) ? { value: "true" } : {}) })}>
          {parameterKinds.map(kind => <option key={kind} value={kind}>{t(`parameters.kind.${kind}`)}</option>)}
        </ToolSelect>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label={`${input.name} · NULL`} checked={input.isNull} onChange={e => update(index, { isNull: e.target.checked })} />NULL</label>
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label={`${input.name} · ${t("parameters.save_default")}`} checked={input.saveDefault} onChange={e => update(index, { saveDefault: e.target.checked })} />{t("parameters.save_default")}</label>
      </div>
      {input.kind === "boolean" ? <ToolSelect aria-label={`${input.name} · ${t("parameters.value")}`} value={input.value} disabled={input.isNull} onChange={e => update(index, { value: e.target.value })}><option value="true">TRUE</option><option value="false">FALSE</option></ToolSelect>
        : <textarea aria-label={`${input.name} · ${t("parameters.value")}`} aria-invalid={!!errors[index]} className="min-h-16 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs outline-none focus:border-brand focus:ring-2 focus:ring-ring/30 disabled:opacity-40" disabled={input.isNull} value={input.value} placeholder={t(`parameters.placeholder.${input.kind}`)} onChange={e => update(index, { value: e.target.value })} />}
      {errors[index] && <p role="alert" className="mt-1 text-xs text-danger">{t(`parameters.error.${errors[index]}`)}</p>}
    </fieldset>)}</div>
    {tooLarge && <p role="alert" className="mt-2 text-xs text-danger">{t("parameters.error.total_size")}</p>}
    <p className="mt-3 text-xs text-muted-foreground">{t("parameters.defaults_hint")}</p>
    </>}
    </fieldset>
  </Modal>;
}
