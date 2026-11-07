import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ParameterPreset, ParameterPresetContent, ParameterPresetSummary } from "@/lib/parameterPresets";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { ToolSelect } from "@/components/tools/ToolKit";
import { useT } from "@/store/i18n";

type Edit = { kind: "save" | "replace" | "rename"; selected?: ParameterPresetSummary } | { kind: "delete"; selected: ParameterPresetSummary };
const errorCodes = new Set(["name", "invalid", "size", "limit", "duplicate", "conflict", "not_found", "corrupt", "storage", "mismatch", "batch_unavailable", "target_changed"]);

export function ParameterPresetLibrary({ content, valuesValid, onLoad, onBusy }: {
  content: ParameterPresetContent; valuesValid: boolean;
  onLoad: (preset: ParameterPreset) => Promise<void>; onBusy: (busy: boolean) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<ParameterPresetSummary[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [name, setName] = useState("");
  const [includeValues, setIncludeValues] = useState(false);
  const mounted = useRef(true);
  const requestId = useRef(0);
  const operation = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestId.current++; }; }, []);
  const describeError = (cause: unknown) => {
    const code = String(cause).replace(/^Error: /, "").replace(/^preset_/, "");
    return t(`parameters.presets.error.${errorCodes.has(code) ? code : "storage"}`);
  };
  const refresh = async () => {
    const generation = ++requestId.current;
    setLoading(true);
    try {
      const presets = await api.listParameterPresets();
      if (mounted.current && generation === requestId.current) { setList(presets); setError(null); }
    } catch (cause) { if (mounted.current && generation === requestId.current) setError(describeError(cause)); }
    finally { if (mounted.current && generation === requestId.current) setLoading(false); }
  };
  useEffect(() => {
    if (!open) return;
    void refresh();
    const updated = () => void refresh();
    window.addEventListener("parameter-presets-updated", updated);
    return () => { requestId.current++; window.removeEventListener("parameter-presets-updated", updated); };
  }, [open]);
  const filtered = list.filter(p => p.driver === content.driver && p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  const selected = filtered.find(p => p.id === selectedId);
  const startEdit = (kind: Edit["kind"]) => {
    if (kind !== "save" && !selected) return;
    setEdit(kind === "delete" ? { kind, selected: selected! } : { kind, selected });
    setName(kind === "save" ? "" : selected!.name);
    setIncludeValues(false); setError(null); setMessage(null);
  };
  const perform = async (work: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(true); onBusy(true); setError(null); setMessage(null);
    try { await work(); }
    catch (cause) { if (mounted.current) setError(describeError(cause)); }
    finally { operation.current = false; if (mounted.current) { setBusy(false); onBusy(false); } }
  };
  const load = () => selected && perform(async () => {
    const preset = await api.getParameterPreset(selected.id);
    if (!mounted.current) return;
    await onLoad(preset);
    if (mounted.current) setMessage(t("parameters.presets.loaded"));
  });
  const save = () => edit && perform(async () => {
    if (edit.kind === "delete") await api.deleteParameterPreset(edit.selected.id, edit.selected.revision);
    else {
      const saved = edit.kind === "rename"
        ? await api.renameParameterPreset(edit.selected!.id, edit.selected!.revision, name.trim())
        : await api.saveParameterPreset({ ...content, sets: includeValues ? content.sets : null, name: name.trim(),
            id: edit.kind === "replace" ? edit.selected!.id : null, revision: edit.kind === "replace" ? edit.selected!.revision : null });
      if (mounted.current) setSelectedId(saved.id);
    }
    if (mounted.current) { setEdit(null); setMessage(t(edit.kind === "delete" ? "parameters.presets.deleted" : "parameters.presets.saved")); }
    window.dispatchEvent(new Event("parameter-presets-updated"));
  });
  return <details className="mb-4 rounded-lg border border-border/70 bg-surface/40 p-3" open={open} onToggle={e => setOpen(e.currentTarget.open)}>
    <summary className="cursor-pointer text-sm font-medium">{t("parameters.presets.title")}</summary>
    <p className="my-2 text-xs text-muted-foreground">{t("parameters.presets.hint")}</p>
    <div className="flex flex-wrap gap-2">
      <input aria-label={t("parameters.presets.search")} placeholder={t("parameters.presets.search")} value={search} onChange={e => setSearch(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-xs" />
      <Button disabled={busy || loading} onClick={() => void refresh()}>{t("parameters.presets.refresh")}</Button>
    </div>
    <ToolSelect className="my-2 w-full" aria-label={t("parameters.presets.select")} value={filtered.some(p => p.id === selectedId) ? selectedId : ""} disabled={busy || loading} onChange={e => { setSelectedId(e.target.value); setError(null); }}>
      <option value="">{loading ? t("parameters.presets.loading") : t("parameters.presets.select")}</option>
      {filtered.map(p => <option key={p.id} value={p.id}>{p.name} · {t(p.mode === "batch" ? "parameters.batch.title" : "parameters.batch.single")} · {p.has_values ? t("parameters.presets.rows", { n: p.set_count }) : t("parameters.presets.definitions")}</option>)}
    </ToolSelect>
    <div className="flex flex-wrap gap-2">
      <Button disabled={busy || !selected || !filtered.some(p => p.id === selectedId)} onClick={() => void load()}>{t("parameters.presets.load")}</Button>
      <Button disabled={busy} onClick={() => startEdit("save")}>{t("parameters.presets.save_new")}</Button>
      <Button disabled={busy || !selected} onClick={() => startEdit("replace")}>{t("parameters.presets.replace")}</Button>
      <Button disabled={busy || !selected} onClick={() => startEdit("rename")}>{t("parameters.presets.rename")}</Button>
      <Button disabled={busy || !selected} onClick={() => startEdit("delete")}>{t("parameters.presets.delete")}</Button>
    </div>
    {error && !edit && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    {message && <p role="status" className="mt-2 text-xs text-muted-foreground">{message}</p>}
    {edit && <Modal open title={t(`parameters.presets.${edit.kind === "save" ? "save_new" : edit.kind}`)} width={460} closeDisabled={busy} onClose={() => setEdit(null)} footer={<>
      <Button disabled={busy} onClick={() => setEdit(null)}>{t("common.cancel")}</Button>
      <Button variant={edit.kind === "delete" ? "danger" : "primary"} disabled={busy || (edit.kind !== "delete" && !name.trim()) || ((edit.kind === "save" || edit.kind === "replace") && includeValues && !valuesValid)} onClick={() => void save()}>{t(edit.kind === "delete" ? "parameters.presets.confirm_delete" : "parameters.presets.confirm_save")}</Button>
    </>}>
      {edit.kind === "delete" ? <p className="break-words text-sm">{t("parameters.presets.delete_hint", { name: edit.selected.name })}</p> : <>
        <label className="block text-xs">{t("parameters.presets.name")}<input maxLength={100} value={name} disabled={busy} onChange={e => setName(e.target.value)} className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm" /></label>
        {edit.kind !== "rename" && <>
          <label className="mt-4 flex items-start gap-2 text-xs"><input type="checkbox" checked={includeValues} disabled={busy} onChange={e => setIncludeValues(e.target.checked)} />{t("parameters.presets.include_values")}</label>
          <p className="mt-2 text-xs text-muted-foreground">{t("parameters.presets.save_hint")}</p>
          {includeValues && !valuesValid && <p role="alert" className="mt-2 text-xs text-danger">{t("parameters.presets.invalid_values")}</p>}
        </>}
      </>}
      {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    </Modal>}
  </details>;
}
