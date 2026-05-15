import type { DriverKind } from "@/types";
import { cn } from "@/lib/cn";

const palette: Record<DriverKind, { bg: string; label: string }> = {
  postgres: { bg: "bg-sky-500/20 text-sky-300 ring-sky-400/30", label: "PG" },
  mysql: { bg: "bg-amber-500/20 text-amber-300 ring-amber-400/30", label: "MY" },
  sqlite: { bg: "bg-violet-500/20 text-violet-300 ring-violet-400/30", label: "SL" },
  redis: { bg: "bg-rose-500/20 text-rose-300 ring-rose-400/30", label: "RD" },
};

export function DriverBadge({
  driver,
  size = "sm",
}: {
  driver: DriverKind;
  size?: "sm" | "md";
}) {
  const p = palette[driver];
  return (
    <span
      className={cn(
        "inline-grid place-items-center rounded-md font-semibold ring-1",
        size === "sm" ? "h-5 w-5 text-[9px]" : "h-6 w-6 text-[10px]",
        p.bg
      )}
    >
      {p.label}
    </span>
  );
}
