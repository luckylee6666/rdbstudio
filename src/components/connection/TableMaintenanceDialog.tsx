import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2 } from "lucide-react";
import type { DriverKind } from "@/types";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Field";
import { useT } from "@/store/i18n";

type Action = "analyze_table" | "optimize_table" | "vacuum_database";
interface Report { message: string; elapsed_ms: number }

export function TableMaintenanceDialog({ connectionId, driver, schema, table, onClose }: {
  connectionId: string; driver: DriverKind; schema?: string; table: string; onClose: () => void;
}) {
  const t = useT();
  const [action, setAction] = useState<Action>("analyze_table");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<Report | null>(null);
  const run = async () => {
    setBusy(true);
    setError("");
    setReport(null);
    try {
      setReport(await invoke<Report>("maintain_table", {
        id: connectionId, action, schema: schema ?? null,
        table: action === "vacuum_database" ? null : table,
      }));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return <Modal open title={t("table_tools.maintenance_title", { table })} onClose={onClose} closeDisabled={busy}
    footer={<><Button variant="ghost" disabled={busy} onClick={onClose}>{t("common.close")}</Button>
      <Button variant="primary" disabled={busy} onClick={() => void run()}>
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{t("table_tools.run")}
      </Button></>}>
    <div className="space-y-4 text-[12px]">
      <label className="block space-y-1.5"><span>{t("table_tools.operation")}</span>
        <Select value={action} disabled={busy} onChange={(event) => {
          setAction(event.target.value as Action); setReport(null); setError("");
        }}>
          <option value="analyze_table">{t("table_tools.analyze")}</option>
          <option value={driver === "sqlite" ? "vacuum_database" : "optimize_table"}>
            {t(driver === "sqlite" ? "table_tools.vacuum_database" : driver === "postgres" ? "table_tools.vacuum_table" : "table_tools.optimize")}
          </option>
        </Select>
      </label>
      <p className="rounded-md border border-warning/30 bg-warning/10 p-3 leading-relaxed">
        {t(action === "vacuum_database" ? "table_tools.database_notice" : "table_tools.lock_notice")}
      </p>
      {error && <p role="alert" className="break-words text-danger">{error}</p>}
      {report && <div role="status" className="space-y-1 rounded-md bg-success/10 p-3 text-success">
        <p>{t("table_tools.done", { ms: report.elapsed_ms })}</p>
        <p className="whitespace-pre-wrap break-words">{report.message}</p>
      </div>}
    </div>
  </Modal>;
}
