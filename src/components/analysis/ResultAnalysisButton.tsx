import { useEffect, useState } from "react";
import { ChartNoAxesCombined, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { useT } from "@/store/i18n";
import { loadResultAnalysis } from "./loadResultAnalysis";
import type { AnalysisSnapshot, ResultAnalysis } from "./ResultAnalysis";

type ModuleState = { component: typeof ResultAnalysis } | { error: true } | null;

function AnalysisDialog({ snapshot, onClose }: { snapshot: AnalysisSnapshot; onClose: () => void }) {
  const t = useT();
  const [loaded, setLoaded] = useState<ModuleState>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadResultAnalysis().then(
      module => { if (active) setLoaded({ component: module.ResultAnalysis }); },
      () => { if (active) setLoaded({ error: true }); },
    );
    // An import cannot be aborted, but closing must never mount late UI or workers.
    return () => { active = false; };
  }, [attempt]);

  if (loaded && "component" in loaded) {
    const Component = loaded.component;
    return <Component snapshot={snapshot} onClose={onClose} />;
  }
  const failed = loaded !== null;
  return <Modal open title={t("analysis.title")} onClose={onClose} footer={<>
    {failed && <Button size="sm" onClick={() => { setLoaded(null); setAttempt(n => n + 1); }}>{t("analysis.retry")}</Button>}
    <Button size="sm" onClick={onClose}>{t("common.close")}</Button>
  </>}>
    <p className="mb-3 truncate text-sm font-medium" title={snapshot.label}>{snapshot.label}</p>
    {failed ? <p role="alert" className="text-sm text-danger">{t("analysis.module_failed")}</p>
      : <div role="status" aria-busy="true" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />{t("analysis.module_loading")}
      </div>}
  </Modal>;
}

/** Capture the clicked snapshot before asynchronous loading or a parent refresh. */
export function ResultAnalysisButton({ columns, rows, scope = "result", label, disabled = false, compact = false }: AnalysisSnapshot & { disabled?: boolean; compact?: boolean }) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<AnalysisSnapshot | null>(null);
  return <>
    <Button size="sm" variant="ghost" title={t("analysis.open")} aria-label={t("analysis.open")} disabled={disabled || !columns.length || snapshot !== null} onClick={() => setSnapshot({ columns, rows, scope, label })}>
      <ChartNoAxesCombined aria-hidden="true" className="h-3.5 w-3.5" />{!compact && t("analysis.open")}
    </Button>
    {snapshot && <AnalysisDialog snapshot={snapshot} onClose={() => setSnapshot(null)} />}
  </>;
}
