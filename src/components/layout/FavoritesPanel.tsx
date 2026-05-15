import { useConnections } from "@/store/connections";
import { DriverBadge } from "@/components/connection/driverIcon";
import { Star } from "lucide-react";
import { useT } from "@/store/i18n";

export function FavoritesPanel() {
  const list = useConnections((s) => s.list);
  const pinned = list.filter((c) => c.pinned);
  const connect = useConnections((s) => s.connect);
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
          pinned.map((c) => (
            <button
              key={c.id}
              onClick={() => void connect(c.id)}
              className="mb-1 flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/50"
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
              <Star className="h-3.5 w-3.5 fill-warning text-warning" />
            </button>
          ))
        )}
      </div>
    </div>
  );
}
