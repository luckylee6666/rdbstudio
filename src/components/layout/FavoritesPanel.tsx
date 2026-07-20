import { useConnections } from "@/store/connections";
import { DriverBadge } from "@/components/connection/driverIcon";
import { Loader2, Star } from "lucide-react";
import { useT } from "@/store/i18n";
import { toast } from "@/store/toasts";

export function FavoritesPanel() {
  const list = useConnections((s) => s.list);
  const pinned = list.filter((c) => c.pinned);
  const connect = useConnections((s) => s.connect);
  const statusMap = useConnections((s) => s.status);
  const t = useT();

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t("sidebar.favorites")}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2">
        {pinned.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-border/80 bg-surface-muted/30 p-5 text-center">
            <div className="mb-2 inline-grid h-9 w-9 place-items-center rounded-md bg-accent">
              <Star className="h-4 w-4" />
            </div>
            <div className="text-[13px] font-medium">{t("sidebar.favorites.empty.title")}</div>
            <div className="mt-0.5 text-[11.5px] text-muted-foreground">
              {t("sidebar.favorites.empty.desc")}
            </div>
          </div>
        ) : (
          pinned.map((c) => {
            const st = statusMap[c.id] ?? "disconnected";
            return (
              <button
                key={c.id}
                disabled={st === "connecting"}
                onClick={() => {
                  if (st === "connected" || st === "connecting") return;
                  connect(c.id).catch((e) =>
                    toast.error(t("favorites.connect_failed"), String(e))
                  );
                }}
                className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/50 disabled:opacity-60"
              >
                <DriverBadge driver={c.driver} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{c.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {c.driver === "sqlite"
                      ? c.file_path ?? "—"
                      : c.driver === "redis"
                      ? `${c.host ?? "?"}:${c.port ?? "?"} · db${c.database ?? "0"}`
                      : `${c.host ?? "?"}${c.database ? " · " + c.database : ""}`}
                  </div>
                </div>
                {st === "connecting" ? (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
                ) : (
                  <span className="flex shrink-0 items-center gap-1.5">
                    {st === "connected" && (
                      <span className="h-1.5 w-1.5 rounded-full bg-success shadow-[0_0_6px_hsl(var(--success))]" />
                    )}
                    <Star className="h-3.5 w-3.5 fill-warning text-warning" />
                  </span>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
