import type { DriverKind } from "@/types";
import { cn } from "@/lib/cn";

const palette: Record<DriverKind, { bg: string; label: string }> = {
  postgres: { bg: "bg-sky-500/15 text-sky-700 ring-sky-500/30 dark:bg-sky-500/20 dark:text-sky-300 dark:ring-sky-400/30", label: "PG" },
  mysql: { bg: "bg-amber-500/15 text-amber-700 ring-amber-500/30 dark:bg-amber-500/20 dark:text-amber-300 dark:ring-amber-400/30", label: "MY" },
  sqlite: { bg: "bg-violet-500/15 text-violet-700 ring-violet-500/30 dark:bg-violet-500/20 dark:text-violet-300 dark:ring-violet-400/30", label: "SL" },
  redis: { bg: "bg-rose-500/15 text-rose-700 ring-rose-500/30 dark:bg-rose-500/20 dark:text-rose-300 dark:ring-rose-400/30", label: "RD" },
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
