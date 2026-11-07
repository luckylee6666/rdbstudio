import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/store/i18n";
import { projectionBudget } from "@/lib/resultAnalysis";
import { CALCULATION_FUNCTIONS, CALCULATION_LIMITS, CALCULATION_TYPES, calculationColumns, prepareCalculations, rewriteReferences, compileExpression, type CalculatedField, type CalculationColumn } from "@/lib/calculatedFields";
import { calculationFailure, type PipelineResponse } from "@/lib/analysisPipeline";
const control = "w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs";
const codes = new Set(["expression", "complexity", "reference", "syntax", "number", "arguments", "limit", "invalid", "name", "overflow", "type", "zero", "precision", "text", "time", "budget"]);
export function calculationErrorText(response: PipelineResponse, t: ReturnType<typeof useT>, fields: CalculatedField[]) {
  const e = response.calculationError;
  if (!e) return t(`analysis.error.${["rows", "size", "depth", "value", "worker"].includes(response.error ?? "") ? response.error : "value"}`);
  return `${e.field >= 0 ? `${fields[e.field]?.name ?? e.field + 1} · ` : ""}${e.row >= 0 ? t("analysis.point_row", { n: e.row + 1 }) + " · " : ""}${t("analysis.calculations.position", { n: Math.max(0,e.position) + 1 })}: ${t(`analysis.calculations.error.${codes.has(e.code) ? e.code : "invalid"}`)}`;
}
export function CalculatedFieldsEditor({ columns, rows, fields, onApply, onClose }: {
  columns: CalculationColumn[]; rows: unknown[][]; fields: CalculatedField[]; onApply: (fields: CalculatedField[]) => void; onClose: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => fields.map(f => ({ ...f }))), [selected, setSelected] = useState(0);
  const [result, setResult] = useState<{ key: string; response: PipelineResponse } | null>(null), [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const worker = useRef<Worker>(), generation = useRef(0), mounted = useRef(true), textarea = useRef<HTMLTextAreaElement>(null);
  const key = JSON.stringify(draft), active = result?.key === key ? result.response : null;
  const referenceColumns = useMemo(() => [...columns, ...calculationColumns(draft.slice(0, selected))], [columns, draft, selected]);
  const cancel = () => { generation.current++; worker.current?.terminate(); worker.current = undefined; setBusy(false); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; worker.current?.terminate(); }; }, []);
  const change = (next: CalculatedField[]) => { cancel(); setDraft(next); setResult(null); setEditError(null); };
  const patch = (patch: Partial<CalculatedField>) => change(draft.map((f,i) => i === selected ? { ...f, ...patch } : f));
  const insert = (text: string) => {
    if (!draft[selected]) return;
    const input = textarea.current, start = input?.selectionStart ?? draft[selected].expression.length, end = input?.selectionEnd ?? start;
    patch({ expression: draft[selected].expression.slice(0,start) + text + draft[selected].expression.slice(end) });
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(start + text.length, start + text.length); });
  };
  const add = () => { let n = draft.length + 1; const names = new Set([...columns, ...draft].map(c => c.name)); while (names.has(`${t("analysis.calculations.default_name")} ${n}`)) n++;
    change([...draft, { id: crypto.randomUUID(), name: `${t("analysis.calculations.default_name")} ${n}`, type: "number", expression: "" }]); setSelected(draft.length);
  };
  const remove = () => {
    try {
      const removed = columns.length + selected;
      const next = draft.filter((_,i) => i !== selected).map(f => ({ ...f, expression: f.expression.trim() ? rewriteReferences(f.expression, i => { if (i === removed) throw new Error("dependency"); return i > removed ? i-1 : i; }) : f.expression }));
      change(next); setSelected(Math.max(0,selected-1));
    } catch { setEditError(t("analysis.calculations.dependency")); }
  };
  const validate = async () => {
    cancel(); const request = ++generation.current; setBusy(true); setResult(null); setEditError(null);
    try {
      if (rows.length > CALCULATION_LIMITS.rows) throw new Error("rows");
      const plan = prepareCalculations(draft, columns), budget = projectionBudget(), projected: unknown[][] = [];
      for (let i=0;i<rows.length;i++) {
        const row = plan.inputs.map(index => rows[i][index]); budget(row); projected.push(row);
        if (i % 256 === 255) { await new Promise(resolve => setTimeout(resolve,0)); if (!mounted.current || generation.current !== request) return; }
      }
      if (!mounted.current || generation.current !== request) return;
      const w = new Worker(new URL("../../lib/calculatedFields.worker.ts", import.meta.url), { type: "module" }); worker.current = w;
      const finish = (response: PipelineResponse) => { w.terminate(); if (mounted.current && generation.current === request) { setResult({ key, response }); setBusy(false); } };
      w.onmessage = event => finish(event.data); w.onerror = () => finish({ error: "worker" }); w.onmessageerror = () => finish({ error: "worker" });
      w.postMessage({ rows: projected, plan });
    } catch (cause) { if (mounted.current && generation.current === request) { setResult({ key, response: calculationFailure(cause) }); setBusy(false); } }
  };
  const current = draft[selected];
  let syntax: string | null = null;
  if (current?.expression.trim()) { try { compileExpression(current.expression, columns.length + selected); } catch (cause) { syntax = calculationErrorText(calculationFailure(cause),t,draft); } }
  return <Modal open title={t("analysis.calculations.title")} width={940} onClose={onClose} footer={<>
    {busy && <Button size="sm" onClick={cancel}>{t("analysis.calculations.cancel")}</Button>}
    <Button size="sm" disabled={busy} onClick={() => void validate()}>{t("analysis.calculations.validate")}</Button>
    <Button size="sm" onClick={onClose}>{t("common.cancel")}</Button>
    <Button size="sm" variant="primary" disabled={busy || (!active?.preview && draft.length > 0)} onClick={() => onApply(draft.map(f => ({ ...f, name: f.name.trim() })))}>{t("analysis.calculations.apply")}</Button>
  </>}>
    <div className="space-y-3 text-xs">
      <p className="text-muted-foreground">{t("analysis.calculations.hint")}</p>
      <div className="grid min-w-0 gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
        <div className="space-y-2">
          <Button size="sm" disabled={draft.length >= CALCULATION_LIMITS.fields} onClick={add}>{t("analysis.calculations.add")}</Button>
          <div className="max-h-72 space-y-1 overflow-auto" role="list" aria-label={t("analysis.calculations.fields")}>{draft.map((f,i) => <Button key={f.id} size="sm" variant={i === selected ? "primary" : "ghost"} className="w-full justify-start" title={f.name} onClick={() => { setSelected(i); setEditError(null); }}><span className="truncate">[{columns.length+i+1}] {f.name}</span></Button>)}</div>
        </div>
        {current ? <div className="min-w-0 space-y-3">
          <div className="grid grid-cols-2 gap-2"><label>{t("analysis.calculations.name")}<input className={`${control} mt-1`} value={current.name} maxLength={100} onChange={e => patch({ name: e.target.value })} /></label><label>{t("analysis.calculations.type")}<select aria-label={t("analysis.calculations.type")} className={`${control} mt-1`} value={current.type} onChange={e => patch({ type: e.target.value as CalculatedField["type"] })}>{CALCULATION_TYPES.map(type => <option key={type} value={type}>{t(`analysis.calculations.type.${type}`)}</option>)}</select></label></div>
          <label className="block">{t("analysis.calculations.expression")}<textarea aria-label={t("analysis.calculations.expression")} ref={textarea} className={`${control} mt-1 h-24 resize-y font-mono`} value={current.expression} maxLength={CALCULATION_LIMITS.expression} spellCheck={false} placeholder="IF(ISNULL([1]), 0, [1] * 100)" onChange={e => patch({ expression: e.target.value })} /></label>
          {syntax && <p role="status" className="text-danger">{syntax}</p>}
          <div className="grid grid-cols-2 gap-2"><label>{t("analysis.calculations.insert_column")}<select aria-label={t("analysis.calculations.insert_column")} className={`${control} mt-1`} value="" onChange={e => { if(e.target.value) insert(e.target.value); }}><option value="">{t("analysis.calculations.choose_column")}</option>{referenceColumns.map((c,i) => <option key={i} value={`[${i+1}]`}>[{i+1}] {c.name} · {c.data_type || "?"}</option>)}</select></label><label>{t("analysis.calculations.insert_function")}<select aria-label={t("analysis.calculations.insert_function")} className={`${control} mt-1`} value="" onChange={e => { if(e.target.value) insert(`${e.target.value}()`); }}><option value="">{t("analysis.calculations.choose_function")}</option>{CALCULATION_FUNCTIONS.map(f => <option key={f}>{f}</option>)}</select></label></div>
          <Button size="sm" variant="danger" onClick={remove}>{t("analysis.calculations.delete")}</Button>
        </div> : <p className="py-8 text-muted-foreground">{t("analysis.calculations.empty")}</p>}
      </div>
      <details className="rounded-md border border-border p-2 text-muted-foreground"><summary className="cursor-pointer">{t("analysis.calculations.rules")}</summary><p className="mt-2 whitespace-pre-line">{t("analysis.calculations.rules_text")}</p></details>
      {editError && <p role="alert" className="text-danger">{editError}</p>}
      {busy && <p role="status">{t("analysis.calculations.busy")}</p>}
      {active?.error && <p role="alert" className="break-words text-danger">{calculationErrorText(active,t,draft)}</p>}
      {active?.preview && <>
        <p role="status">{t("analysis.calculations.valid", { n: active.preview.count })}</p>
        {active.preview.stats.roundedRows > 0 && <p className="text-muted-foreground">{t("analysis.calculations.rounded", { n: active.preview.stats.roundedRows })}</p>}
        <div className="max-h-56 overflow-auto rounded-md border border-border"><table className="w-full text-xs"><thead className="sticky top-0 bg-surface-elevated"><tr><th className="p-2 text-left">#</th>{draft.map(f => <th key={f.id} className="max-w-48 truncate p-2 text-left" title={f.name}>{f.name}</th>)}</tr></thead><tbody>{active.preview.rows.map((row,i) => <tr className="border-t border-border" key={i}><th className="p-2 text-left font-normal">{i+1}</th>{row.map((cell,j) => <td key={j} className="max-w-60 truncate p-2 font-mono" title={String(cell.value)}>{cell.rounded ? "≈ " : ""}{cell.value === null ? "NULL" : String(cell.value)}</td>)}</tr>)}</tbody></table></div>
      </>}
    </div>
  </Modal>;
}
