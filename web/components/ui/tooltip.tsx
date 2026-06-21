"use client";

import * as React from "react";

const OPEN_DELAY_MS = 200;
const CLOSE_DELAY_MS = 80;

/**
 * Drop-in hover tooltip. Wraps any single child + surfaces `content` in a
 * portal-positioned popup. Mirrors the upstream app's `<Tooltip>` API surface so we
 * can port markup verbatim:
 *
 *   <Tooltip content="hint text">
 *     <button>...</button>
 *   </Tooltip>
 *
 * The popup is `position: fixed` and positioned via getBoundingClientRect of
 * the trigger, so it escapes overflow:hidden ancestors (cards, table
 * cells) without needing a real portal. Flips top↔bottom when too close to
 * the viewport edge.
 *
 * `content` accepts strings or arbitrary JSX, so the tooltip can carry rich
 * markup (rows, multiple paragraphs, formatted timestamps).
 */
export function Tooltip({
  content,
  children,
  side = "bottom",
  align = "center",
  className = "",
  triggerClassName = "",
  delay = OPEN_DELAY_MS,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /** Extra classes for the POPUP. */
  className?: string;
  /** Extra classes for the trigger wrapper span. It replaces the child as
   * the flex/grid item in the caller's layout, so alignment opt-outs the
   * child carried (`self-center` in a baseline row, …) must move here. */
  triggerClassName?: string;
  delay?: number;
}) {
  const [open, setOpen] = React.useState(false);
  const [coords, setCoords] = React.useState<{
    top: number;
    left: number;
    placement: "top" | "bottom" | "left" | "right";
  } | null>(null);
  const triggerRef = React.useRef<HTMLSpanElement | null>(null);
  const popupRef = React.useRef<HTMLDivElement | null>(null);
  const openTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = React.useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const reposition = React.useCallback(() => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const popH = popupRef.current?.offsetHeight ?? 32;
    const popW = popupRef.current?.offsetWidth ?? 200;
    const margin = 6;

    let placement: "top" | "bottom" | "left" | "right" = side;
    if (side === "bottom" && r.bottom + popH + margin > window.innerHeight) {
      placement = "top";
    } else if (side === "top" && r.top - popH - margin < 0) {
      placement = "bottom";
    }

    let top = 0;
    let left = 0;
    if (placement === "bottom") {
      top = r.bottom + margin;
      left =
        align === "start"
          ? r.left
          : align === "end"
            ? r.right - popW
            : r.left + r.width / 2 - popW / 2;
    } else if (placement === "top") {
      top = r.top - popH - margin;
      left =
        align === "start"
          ? r.left
          : align === "end"
            ? r.right - popW
            : r.left + r.width / 2 - popW / 2;
    } else if (placement === "right") {
      top = r.top + r.height / 2 - popH / 2;
      left = r.right + margin;
    } else {
      top = r.top + r.height / 2 - popH / 2;
      left = r.left - popW - margin;
    }
    // Clamp to viewport with 4px margin.
    left = Math.max(4, Math.min(left, window.innerWidth - popW - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - popH - 4));
    setCoords({ top, left, placement });
  }, [side, align]);

  const onEnter = React.useCallback(() => {
    cancel();
    openTimer.current = setTimeout(() => {
      setOpen(true);
      // First reposition; popup width unknown until mount → reposition again
      // on next frame once layout settles.
      requestAnimationFrame(reposition);
      requestAnimationFrame(() => requestAnimationFrame(reposition));
    }, delay);
  }, [cancel, delay, reposition]);

  const onLeave = React.useCallback(() => {
    cancel();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [cancel]);

  // Re-position on scroll/resize while open.
  React.useEffect(() => {
    if (!open) return;
    const handler = () => reposition();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open, reposition]);

  React.useEffect(() => cancel, [cancel]);

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        className={`inline-flex ${triggerClassName}`}
      >
        {children}
      </span>
      {open && coords && (
        <div
          ref={popupRef}
          role="tooltip"
          onMouseEnter={cancel}
          onMouseLeave={onLeave}
          style={{
            position: "fixed",
            top: coords.top,
            left: coords.left,
            zIndex: 200,
          }}
          className={`pointer-events-auto rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] leading-relaxed text-popover-foreground shadow-lg max-w-xs whitespace-normal ${className}`}
        >
          {content}
        </div>
      )}
    </>
  );
}

/**
 * Legacy compound API surface kept for any caller using the previous shape:
 *
 *   <Tooltip>
 *     <TooltipTrigger>
 *       <button>…</button>
 *     </TooltipTrigger>
 *     <TooltipContent>hint</TooltipContent>
 *   </Tooltip>
 *
 * Discouraged in new code; use the single-prop form above. These shims are
 * pass-throughs so existing markup keeps working until callers migrate.
 */
export function TooltipTrigger({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

export function TooltipContent({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      role="tooltip"
      className={`pointer-events-none absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-50 max-w-xs min-w-max w-max whitespace-normal rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] leading-relaxed text-popover-foreground shadow-lg opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-100 ${className}`}
    >
      {children}
    </span>
  );
}
