import { useRef, useState } from "react";
import { saveTextFile } from "@/lib/csv";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/Button";
import { ToolSelect } from "@/components/tools/ToolKit";
import { useT } from "@/store/i18n";
import { parameterKinds, type ParameterKind } from "@/lib/queryParameters";
import { MAX_PARAMETER_SETS, parameterBatchIssue, parseParameterRows, type BatchFormat, type ParameterBatchDraft } from "@/lib/parameterBatch";

export function ParameterBatchEditor({ draft, onChange }: { draft: ParameterBatchDraft; onChange: (draft: ParameterBatchDraft) => void }) {
  const t = useT();
  const [page, setPage] = useState(0);
  const fileRead = useRef(0);
  const [text, setText] = useState("");
  const [format, setFormat] = useState<BatchFormat>("csv");
  const [message, setMessage] = useState<string | null>(null);
  const names = Object.keys(draft.types);
  const maxPage = Math.max(0, Math.ceil(draft.rows.length / 10) - 1);
  const currentPage = Math.min(page, maxPage);
  const issue = parameterBatchIssue(draft.rows, draft.types);
  const setRows = (rows: ParameterBatchDraft["rows"]) => onChange({ ...draft, rows });
  const cell = (row: number, name: string, value: string | null) => setRows(draft.rows.map((item, index) => index === row ? { ...item, [name]: value } : item));
  const importRows = () => {
    try { setRows(parseParameterRows(text, format, names)); setPage(0); setMessage(null); }
    catch (error) { setMessage(t(`parameters.batch.error.${(error as Error).message}`)); }
  };
  return <div className="min-w-0 space-y-3">
    <p className="text-xs text-muted-foreground">{t("parameters.batch.hint")}</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={draft.rows.length >= MAX_PARAMETER_SETS} onClick={() => { setRows([...draft.rows, Object.fromEntries(names.map(name => [name, ""]))]); setPage(Math.floor(draft.rows.length / 10)); }}>{t("parameters.batch.add")}</Button>
      <Button disabled={draft.rows.length >= MAX_PARAMETER_SETS} onClick={() => { setRows([...draft.rows, { ...draft.rows.at(-1)! }]); setPage(Math.floor(draft.rows.length / 10)); }}>{t("parameters.batch.duplicate")}</Button>
      <Button onClick={async () => { try { await writeText(JSON.stringify(draft.rows, null, 2)); setMessage(t("parameters.batch.copied")); } catch { setMessage(t("parameters.batch.copy_failed")); } }}>{t("parameters.batch.copy")}</Button>
      <Button onClick={async () => { try { const path = await saveTextFile("parameters.json", JSON.stringify(draft.rows, null, 2), "json"); if (path) setMessage(t("parameters.batch.exported")); } catch { setMessage(t("parameters.batch.export_failed")); } }}>{t("parameters.batch.export")}</Button>
      <span className="ml-auto text-xs text-muted-foreground">{t("parameters.batch.count", { n: draft.rows.length })}</span>
    </div>
    <div className="max-h-[340px] overflow-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 z-10 bg-surface-muted"><tr><th className="min-w-12 px-2 py-2">#</th>{names.map(name => <th key={name} className="min-w-[180px] border-l border-border p-2 text-left">
          <span className="mb-1 block font-mono text-brand">:{name}</span>
          <ToolSelect aria-label={`${name} · ${t("parameters.type")}`} value={draft.types[name]} onChange={e => onChange({ ...draft, types: { ...draft.types, [name]: e.target.value as ParameterKind } })}>{parameterKinds.map(kind => <option key={kind} value={kind}>{t(`parameters.kind.${kind}`)}</option>)}</ToolSelect>
        </th>)}<th className="min-w-16" /></tr></thead>
        <tbody>{draft.rows.slice(currentPage * 10, currentPage * 10 + 10).map((row, offset) => {
          const index = currentPage * 10 + offset;
          return <tr key={index} className="border-t border-border align-top"><th className="p-2 font-normal text-muted-foreground">{index + 1}</th>{names.map(name => <td key={name} className="border-l border-border p-2">
            <textarea aria-label={t("parameters.batch.cell", { n: index + 1, name })} aria-invalid={issue?.row === index + 1 && issue.name === name} value={row[name] ?? ""} disabled={row[name] === null} onChange={e => cell(index, name, e.target.value)} className="min-h-14 w-full resize-y rounded border border-border bg-background px-2 py-1 font-mono outline-none focus:border-brand disabled:opacity-40" />
            <label className="mt-1 flex items-center gap-1 text-muted-foreground"><input type="checkbox" aria-label={t("parameters.batch.null", { n: index + 1, name })} checked={row[name] === null} onChange={e => cell(index, name, e.target.checked ? null : "")} />NULL</label>
          </td>)}<td className="p-2"><Button disabled={draft.rows.length === 1} aria-label={t("parameters.batch.remove_row", { n: index + 1 })} onClick={() => setRows(draft.rows.filter((_, i) => i !== index))}>{t("parameters.batch.remove")}</Button></td></tr>;
        })}</tbody>
      </table>
    </div>
    <div className="flex items-center justify-between gap-2 text-xs">
      <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t("parameters.batch.previous")}</Button>
      <span>{currentPage + 1} / {maxPage + 1}</span>
      <Button disabled={currentPage === maxPage} onClick={() => setPage(currentPage + 1)}>{t("parameters.batch.next")}</Button>
    </div>
    {issue && <p role="alert" className="text-xs text-danger">{issue.row && `${t("parameters.batch.cell", { n: issue.row, name: issue.name ?? "" })}: `}{issue.code.startsWith("value.") ? t(`parameters.error.${issue.code.slice(6)}`) : t(`parameters.batch.error.${issue.code}`)}</p>}
    <details className="rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm">{t("parameters.batch.import")}</summary>
      <p className="my-2 text-xs text-muted-foreground">{t("parameters.batch.import_hint")}</p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ToolSelect aria-label={t("parameters.batch.format")} value={format} onChange={e => setFormat(e.target.value as BatchFormat)}><option value="csv">CSV</option><option value="tsv">TSV</option><option value="json">JSON</option></ToolSelect>
        <label className="min-w-0 text-xs">{t("parameters.batch.file")}<input type="file" accept=".csv,.tsv,.json,.txt" className="ml-2 max-w-full text-xs" onChange={async e => {
          const generation = ++fileRead.current;
          const file = e.target.files?.[0]; if (!file) return;
          if (file.size > 8 * 1024 * 1024) { setMessage(t("parameters.batch.error.size")); return; }
          try { const content = await file.text(); if (generation !== fileRead.current) return; setText(content); const ext = file.name.split(".").at(-1); if (ext === "csv" || ext === "tsv" || ext === "json") setFormat(ext); setMessage(null); }
          catch { if (generation === fileRead.current) setMessage(t("parameters.batch.error.file")); }
        }} /></label>
      </div>
      <textarea aria-label={t("parameters.batch.paste")} className="h-28 w-full resize-y rounded border border-border bg-background p-2 font-mono text-xs" value={text} onChange={e => { fileRead.current++; setText(e.target.value); }} placeholder={names.join(",")} />
      <Button onClick={importRows}>{t("parameters.batch.replace")}</Button>
    </details>
    {message && <p role="status" className="break-words text-xs">{message}</p>}
    <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={draft.atomic} onChange={e => onChange({ ...draft, atomic: e.target.checked })} />{t("parameters.batch.atomic")}</label>
    <p className="text-xs text-muted-foreground">{t("parameters.batch.atomic_hint")}</p>
  </div>;
}
