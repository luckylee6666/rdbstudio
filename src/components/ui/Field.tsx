import { cn } from "@/lib/cn";
import { forwardRef } from "react";

export function Label({
  children,
  required,
  hint,
}: {
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="mb-1 flex items-center gap-1.5">
      <label className="text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {children}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </label>
      {hint && <span className="text-[11px] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

export const Input = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...rest }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-9 w-full rounded-md border border-border/80 bg-surface px-2.5 text-[13px]",
      "placeholder:text-muted-foreground/60",
      "focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-ring/40",
      className
    )}
    {...rest}
  />
));
Input.displayName = "Input";

export const Select = forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...rest }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-9 w-full rounded-md border border-border/80 bg-surface px-2 text-[13px]",
      "focus:border-brand/60 focus:outline-none focus:ring-2 focus:ring-ring/40",
      className
    )}
    {...rest}
  >
    {children}
  </select>
));
Select.displayName = "Select";
