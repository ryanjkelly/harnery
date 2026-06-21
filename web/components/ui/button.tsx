import * as React from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

type Variant =
  | "default"
  | "outline"
  | "destructive"
  | "ghost"
  | "secondary"
  | "link";
type Size =
  | "default"
  | "sm"
  | "xs"
  | "lg"
  | "icon"
  | "icon-sm"
  | "icon-xs"
  | "icon-lg"
  // legacy "md" alias from earlier harnery passes; maps to the default size.
  | "md";

/**
 * Button primitive. Mirrors the upstream app byte-for-byte:
 *
 * - rounded-lg default + rounded-md ramps for the dense sm/xs sizes
 *   (the upstream app uses `rounded-[min(var(--radius-md),12px)]`; harnery's
 *   tighter --radius gives the equivalent visual weight at rounded-md).
 * - per-size svg auto-sizing via `[&_svg:not([class*='size-'])]:size-X`,
 *   so consumers can omit explicit `size-3` on icons.
 * - `active:translate-y-px` press feedback.
 * - `focus-visible:ring-2 ring-ring/50` focus state.
 * - When `tooltip` is provided the whole button wraps in a custom
 *   <Tooltip> so hover surfaces a styled popover even on disabled
 *   buttons (the wrapper handles hover at the span level).
 */
const VARIANT_CLS: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground hover:bg-primary/85",
  outline:
    "border border-border bg-background hover:bg-muted hover:text-foreground text-foreground dark:bg-input/30 dark:hover:bg-input/50",
  secondary:
    "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  destructive:
    "bg-destructive/10 text-destructive hover:bg-destructive/20 border border-destructive/40 dark:bg-destructive/20 dark:hover:bg-destructive/30",
  ghost: "text-foreground hover:bg-muted/60",
  link: "text-primary underline-offset-4 hover:underline",
};

const SIZE_CLS: Record<Size, string> = {
  default:
    "h-8 gap-1.5 px-2.5 rounded-lg [&_svg:not([class*='size-'])]:size-4",
  md: "h-8 gap-1.5 px-2.5 rounded-lg [&_svg:not([class*='size-'])]:size-4",
  sm: "h-7 gap-1 px-2.5 text-xs rounded-md [&_svg:not([class*='size-'])]:size-3.5",
  xs: "h-6 gap-1 px-2 text-[10px] rounded-md [&_svg:not([class*='size-'])]:size-3",
  lg: "h-9 gap-1.5 px-2.5 rounded-lg [&_svg:not([class*='size-'])]:size-4",
  icon: "size-8 rounded-lg [&_svg:not([class*='size-'])]:size-4",
  "icon-sm": "size-7 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
  "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
  "icon-lg": "size-9 rounded-lg [&_svg:not([class*='size-'])]:size-4",
};

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    size?: Size;
    tooltip?: React.ReactNode;
  }
>(function Button(
  {
    variant = "default",
    size = "default",
    className,
    tooltip,
    children,
    title,
    ...rest
  },
  ref,
) {
  const btn = (
    <button
      ref={ref}
      type={rest.type ?? "button"}
      // When tooltip is set we use the custom popover; suppress the native
      // browser one so we don't get a double-stacked hint.
      title={tooltip ? undefined : title}
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-transparent font-medium whitespace-nowrap transition-all outline-none select-none active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        VARIANT_CLS[variant],
        SIZE_CLS[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  return tooltip ? <Tooltip content={tooltip}>{btn}</Tooltip> : btn;
});

/**
 * Variant-only string helper, useful when an anchor (Link/<a>) needs to
 * look like a Button but Button's <button>-element rendering won't do.
 * Mirrors the upstream app's buttonVariants export. Caller is responsible for
 * passing className straight to the anchor.
 */
export function buttonVariants({
  variant = "default",
  size = "default",
  className,
}: {
  variant?: Variant;
  size?: Size;
  className?: string;
} = {}): string {
  return cn(
    "inline-flex shrink-0 items-center justify-center border border-transparent font-medium whitespace-nowrap transition-all outline-none select-none active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
    VARIANT_CLS[variant],
    SIZE_CLS[size],
    className,
  );
}
