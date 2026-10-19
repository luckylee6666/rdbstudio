import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT } from "@/store/i18n";

interface Progress {
  stage: string;
  bytes_done: number;
  bytes_total: number | null;
  elapsed_ms: number;
}

export function DbIoProgress({ operationId }: { operationId: string | null }) {
  const t = useT();
  const [progress, setProgress] = useState<Progress | null>(null);
  useEffect(() => {
    if (!operationId) {
      setProgress(null);
      return;
    }
    let stopped = false;
    const poll = async () => {
      try {
        const value = await invoke<Progress | null>("db_io_progress", { operationId });
        if (!stopped) setProgress(value);
      } catch {
        /* the operation may have ended */
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [operationId]);
  if (!operationId || !progress) return null;
  const amount = (progress.bytes_done / 1024 / 1024).toFixed(1);
  const total = progress.bytes_total ? `${(progress.bytes_total / 1024 / 1024).toFixed(1)} MiB` : null;
  const percent = progress.bytes_total ? Math.min(100, (progress.bytes_done / progress.bytes_total) * 100) : null;
  const stage = t(
    `dbio.stage.${progress.stage === "applying" || progress.stage === "reading" ? progress.stage : "writing"}`
  );
  return (
    <div role="status" className="space-y-1 text-[11px] text-muted-foreground">
      <span>
        {stage} · {amount} MiB{total ? ` / ${total}` : ""} · {(progress.elapsed_ms / 1000).toFixed(1)}s
      </span>
      <div
        className="h-1 w-full overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-label={stage}
        aria-valuenow={percent ?? undefined}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={percent == null ? "h-full w-1/3 animate-pulse rounded-full bg-brand/60" : "h-full rounded-full bg-brand transition-[width]"}
          style={percent == null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
