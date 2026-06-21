import * as React from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

type Variant =
  | "default"
  | "outline"
  | "secondary"
  | "muted"
  | "info"
  | "success"
  | "warning"
  | "destructive"
  | "accent";

/**
 * Badge: mirrors the upstream app's class shape (rounded-md, tracking-wider,
 * solid default/secondary, bordered semantic variants). When `title` is
 * provided the whole badge wraps in a styled <Tooltip>, suppressing the
 * native browser tooltip so hover surfaces consistent chrome.
 */
const VARIANT_CLS: Record<Variant, string> = {
  // default = solid neutral (the upstream app: --primary is near-white in dark mode, not
  // a brand color). Brand-tinted variants live in info/success/warning/etc.
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "border-border text-foreground bg-background",
  muted: "border-border/60 bg-muted text-muted-foreground",
  info: "border-sky-500/60 bg-sky-500/10 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300",
  success:
    "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
  warning:
    "border-amber-500/60 bg-amber-500/10 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
  destructive:
    "border-destructive/60 bg-destructive/10 text-destructive dark:bg-destructive/20",
  accent:
    "border-purple-500/60 bg-purple-500/10 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300",
};

export function Badge({
  variant = "muted",
  className,
  title,
  children,
  ...props
}: Omit<React.ComponentProps<"span">, "title"> & {
  variant?: Variant;
  title?: React.ReactNode;
}) {
  const cursor = title ? "cursor-help" : "";
  const inner = (
    <span
      data-slot="badge"
      // NOTE: deliberately no `leading-none`. the upstream app's Badge cva has it, but
      // every caller passes `text-[10px]` again in className which triggers
      // twMerge's text-size/line-height dedup heuristic, so leading-none is
      // always stripped in practice. The visual intent (15px line-box at
      // text-[10px]) comes from inheriting `line-height: 1.5` from Tailwind's
      // preflight `html` rule. Adding leading-none here would shrink the chip
      // to 10px, which doesn't match the upstream app's actual rendering.
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium tracking-wider uppercase whitespace-nowrap shrink-0 [&>svg]:size-3 [&>svg]:pointer-events-none transition-colors",
        cursor,
        VARIANT_CLS[variant],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
  return title ? <Tooltip content={title}>{inner}</Tooltip> : inner;
}
