import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { api } from "@/lib/api";
import { saveTextFile } from "@/lib/csv";
import { useT } from "@/store/i18n";
import { ANALYSIS_CONFIG_BYTES, applyAnalysisConfiguration, parseAnalysisConfiguration, parseAnalysisConfigurationText, suggestAnalysisMapping, type AnalysisColumn, type AnalysisConfiguration, type AnalysisPresetSummary, type AnalysisSettings, type AnalysisMapping, type ColumnBinding, type BindingRole } from "@/lib/analysisPresets";

type Edit = { kind: "save" | "replace" | "rename" | "delete" | "export"; selected?: AnalysisPresetSummary };
const control = "w-full min-w-0 rounded-md border border-border bg-background px-2 py-2 text-xs";
const errorCodes = new Set(["invalid", "version", "size", "target", "range", "mismatch", "name", "limit", "duplicate", "conflict", "not_found", "corrupt", "storage"]);
const roleLabels: Record<BindingRole, string> = { profile: "column", row: "row", split: "split", measure: "measure", x: "scatter_x", y: "scatter_y", label: "point_label" };

export function AnalysisPresetLibrary({ columns, capture, onLoad, disabled, onOpenChange }: {
  columns: AnalysisColumn[]; capture: (includeSeries: boolean) => AnalysisConfiguration;
  onLoad: (settings: AnalysisSettings, config: AnalysisConfiguration) => void;
  disabled: boolean; onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [list, setList] = useState<AnalysisPresetSummary[]>([]), [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState(""), [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null), [name, setName] = useState(""), [includeSeries, setIncludeSeries] = useState(false);
  const [preview, setPreview] = useState<AnalysisConfiguration | null>(null), [mapping, setMapping] = useState<AnalysisMapping>({});
  const mounted = useRef(true), opened = useRef(false), operation = useRef(false), requestId = useRef(0), fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);
  const live = () => mounted.current && opened.current;
  const describe = (cause: unknown) => { const code = String(cause).replace(/^Error: /, "").replace(/^preset_/, ""); return t(`analysis.presets.error.${errorCodes.has(code) ? code : "storage"}`); };
  const refresh = async () => {
    const generation = ++requestId.current; setLoading(true);
    try { const items = await api.listAnalysisPresets(); if (live() && generation === requestId.current) setList(items); }
    catch (cause) { if (live() && generation === requestId.current) setError(describe(cause)); }
    finally { if (live() && generation === requestId.current) setLoading(false); }
  };
  useEffect(() => {
    if (!open) return;
    void refresh(); const update = () => void refresh(); window.addEventListener("analysis-presets-updated", update);
    return () => { requestId.current++; window.removeEventListener("analysis-presets-updated", update); };
  }, [open]);
  const toggle = (value: boolean) => { opened.current = value; setOpen(value); onOpenChange(value); setError(null); setMessage(null); setEdit(null); setPreview(null); };
  const perform = async (work: () => Promise<void>) => {
    if (operation.current || !live()) return;
    operation.current = true; setBusy(true); setError(null); setMessage(null);
    try { await work(); } catch (cause) { if (live()) setError(describe(cause)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const filtered = list.filter(p => p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())).sort((a,b) => a.name.localeCompare(b.name));
  const selected = filtered.find(p => p.id === selectedId);
  const startEdit = (kind: Edit["kind"]) => {
    if (["replace", "rename", "delete"].includes(kind) && !selected) return;
    setEdit({ kind, selected }); setName(kind === "save" ? "" : selected?.name ?? ""); setIncludeSeries(false); setError(null); setMessage(null);
  };
  const showPreview = (config: AnalysisConfiguration) => { const valid = parseAnalysisConfiguration(config); setPreview(valid); setMapping(suggestAnalysisMapping(valid, columns)); };
  const load = () => selected && perform(async () => { const saved = await api.getAnalysisPreset(selected.id); if (live()) showPreview(saved.config); });
  const importFile = (file: File) => perform(async () => {
    if (file.size > ANALYSIS_CONFIG_BYTES) throw new Error("preset_size");
    const input = await file.text(); if (live()) showPreview(parseAnalysisConfigurationText(input));
  });
  const save = () => edit && perform(async () => {
    if (edit.kind === "export") {
      await saveTextFile("analysis-configuration.json", JSON.stringify(capture(includeSeries)), "json");
    } else if (edit.kind === "delete") await api.deleteAnalysisPreset(edit.selected!.id, edit.selected!.revision);
    else {
      const saved = edit.kind === "rename"
        ? await api.renameAnalysisPreset(edit.selected!.id, edit.selected!.revision, name.trim())
        : await api.saveAnalysisPreset({ name: name.trim(), id: edit.kind === "replace" ? edit.selected!.id : null,
            revision: edit.kind === "replace" ? edit.selected!.revision : null, config: capture(includeSeries) });
      if (live()) setSelectedId(saved.id);
    }
    if (live()) { setEdit(null); setMessage(t(`analysis.presets.${edit.kind === "delete" ? "deleted" : edit.kind === "export" ? "export_done" : "saved"}`)); }
    if (edit.kind !== "export") window.dispatchEvent(new Event("analysis-presets-updated"));
  });
  const mappingRows: { key: keyof AnalysisMapping; label: string; binding: ColumnBinding }[] = preview ? [
    ...Object.entries(preview.bindings).flatMap(([role,binding]) => "calculated" in binding ? [] : [{ key: role as BindingRole, label: t(`analysis.${roleLabels[role as BindingRole]}`), binding }]),
    ...preview.calculations?.inputs.map((binding,i) => ({ key: `input:${i}` as const, label: `${t("analysis.calculations.input")} [${i+1}]`, binding })) ?? [],
  ] : [];
  const mapped = preview && mappingRows.every(({ key }) => Number.isInteger(mapping[key]) && columns[mapping[key]!]);
  const apply = () => {
    if (!preview || !mapped || busy) return;
    try { const settings = applyAnalysisConfiguration(preview, columns, mapping); onLoad(settings, preview); toggle(false); }
    catch (cause) { setError(describe(cause)); }
  };
  const editTitle = edit && t(`analysis.presets.${edit.kind === "save" ? "save_new" : edit.kind}`);
  return <>
    <Button size="sm" variant="ghost" disabled={disabled || open} onClick={() => toggle(true)}>{t("analysis.presets.title")}</Button>
    {open && <Modal open title={t("analysis.presets.title")} width={720} onClose={() => toggle(false)} closeDisabled={busy} footer={<Button disabled={busy} onClick={() => toggle(false)}>{t("common.close")}</Button>}>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("analysis.presets.hint")}</p>
        <div className="flex gap-2"><input aria-label={t("analysis.presets.search")} placeholder={t("analysis.presets.search")} className={control} value={search} disabled={busy} onChange={e => setSearch(e.target.value)} /><Button size="sm" disabled={busy || loading} onClick={() => { setError(null); void refresh(); }}>{t("analysis.presets.refresh")}</Button></div>
        <select className={control} aria-label={t("analysis.presets.select")} value={selected?.id ?? ""} disabled={busy || loading} onChange={e => { setSelectedId(e.target.value); setError(null); }}>
          <option value="">{t(loading ? "analysis.presets.loading" : "analysis.presets.select")}</option>
          {filtered.map(p => <option key={p.id} value={p.id}>{p.name} · {t(`analysis.${p.mode === "chart" ? p.chart : p.mode}`)}{p.has_series_values ? ` · ${t("analysis.presets.has_values")}` : ""}</option>)}
        </select>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || loading || !selected} onClick={() => void load()}>{t("analysis.presets.load")}</Button>
          {(["save", "replace", "rename", "delete"] as const).map(action => <Button size="sm" key={action} disabled={busy || (action !== "save" && (loading || !selected))} onClick={() => startEdit(action)}>{t(`analysis.presets.${action === "save" ? "save_new" : action}`)}</Button>)}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          <Button size="sm" disabled={busy} onClick={() => fileInput.current?.click()}>{t("analysis.presets.import")}</Button>
          <Button size="sm" disabled={busy} onClick={() => startEdit("export")}>{t("analysis.presets.export")}</Button>
          <input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label={t("analysis.presets.import")} onChange={e => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void importFile(file); }} />
        </div>
        {error && !edit && !preview && <p role="alert" className="text-xs text-danger">{error}</p>}
        {message && <p role="status" className="text-xs text-muted-foreground">{message}</p>}
      </div>
      {edit && <Modal open title={editTitle!} width={520} onClose={() => { setEdit(null); setError(null); }} closeDisabled={busy} footer={<>
        <Button disabled={busy} onClick={() => { setEdit(null); setError(null); }}>{t("common.cancel")}</Button>
        <Button variant={edit.kind === "delete" ? "danger" : "primary"} disabled={busy || (!["delete", "export"].includes(edit.kind) && !name.trim())} onClick={() => void save()}>{t(`analysis.presets.${edit.kind === "delete" ? "confirm_delete" : edit.kind === "export" ? "export" : "confirm_save"}`)}</Button>
      </>}>
        {edit.kind === "delete" ? <p className="break-words text-sm">{t("analysis.presets.delete_hint", { name: edit.selected!.name })}</p> : <div className="space-y-3">
          {edit.kind !== "export" && <label className="block text-xs">{t("analysis.presets.name")}<input className={`${control} mt-1`} disabled={busy} value={name} maxLength={100} onChange={e => setName(e.target.value)} /></label>}
          {edit.kind !== "rename" && <><p className="text-xs text-muted-foreground">{t("analysis.presets.save_hint")}</p><label className="flex items-start gap-2 text-xs"><input type="checkbox" disabled={busy} checked={includeSeries} onChange={e => setIncludeSeries(e.target.checked)} />{t("analysis.presets.include_series")}</label></>}
        </div>}
        {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
      </Modal>}
      {preview && <Modal open title={t("analysis.presets.mapping")} width={740} onClose={() => { setPreview(null); setError(null); }} footer={<><Button onClick={() => { setPreview(null); setError(null); }}>{t("common.cancel")}</Button><Button variant="primary" disabled={!mapped || busy} onClick={apply}>{t("analysis.presets.apply")}</Button></>}>
        <div className="space-y-3 text-xs">
          <p className="font-medium">{t(`analysis.${preview.mode}`)} · {t(`analysis.${preview.chart}`)} · {t(`analysis.${preview.aggregate}`)}</p>
          <p className="text-muted-foreground">{t("analysis.presets.mapping_hint")}</p>
          {mappingRows.map(({key, label, binding}) => <label key={key} className="grid min-w-0 gap-2 rounded-md border border-border p-3 sm:grid-cols-2">
            <span className="min-w-0 break-all"><span className="font-medium">{label}</span><br />{binding.ordinal + 1}. {binding.name} · {binding.dataType || "?"}</span>
            <select className={control} aria-label={label} value={mapping[key] ?? ""} onChange={e => setMapping(current => ({ ...current, [key]: e.target.value === "" ? undefined : Number(e.target.value) }))}>
              <option value="">{t("analysis.presets.choose_column")}</option>{columns.map((column, index) => <option value={index} key={index}>{index + 1}. {column.name} · {column.data_type || "?"}</option>)}
            </select>
          </label>)}
          {preview.calculations && <div className="space-y-2 rounded-md border border-border p-3"><p className="font-medium">{t("analysis.calculations.saved")}</p>{preview.calculations.fields.map((field,i) => <div key={field.id} className="min-w-0"><label className="block">[{preview.calculations!.inputs.length+i+1}] {t("analysis.calculations.name")} · {t(`analysis.calculations.type.${field.type}`)}<input className={`${control} mt-1`} aria-label={`${t("analysis.calculations.name")} [${preview.calculations!.inputs.length+i+1}]`} value={field.name} maxLength={100} onChange={e => setPreview({ ...preview, calculations: { ...preview.calculations!, fields: preview.calculations!.fields.map((f,j) => i === j ? { ...f, name: e.target.value } : f) } })} /></label><p className="break-all font-mono text-muted-foreground">{field.expression}</p></div>)}</div>}
          <p className="text-muted-foreground">{t(`analysis.presets.series.${preview.series.mode}`)}</p>
          {error && <p role="alert" className="text-danger">{error}</p>}
        </div>
      </Modal>}
    </Modal>}
  </>;
}
