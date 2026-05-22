import { cn } from "@/lib/cn";
import { forwardRef } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

// shrink-0 + whitespace-nowrap keeps CJK labels like "测试连接" from getting
// crushed into one-character-per-line columns when the parent flex row also
// contains a long error message.
const base =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-brand text-brand-foreground hover:bg-brand/90 shadow-soft",
  secondary:
    "bg-surface-muted text-foreground hover:bg-accent border border-border/70",
  ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
  danger: "bg-danger text-white hover:bg-danger/90",
};

const sizes: Record<Size, string> = {
  sm: "h-7 px-2.5 text-[12px]",
  md: "h-8 px-3 text-[13px]",
};

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = "secondary", size = "md", ...rest }, ref) => (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      {...rest}
    />
  )
);
Button.displayName = "Button";
