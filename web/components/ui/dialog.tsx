"use client";

import * as React from "react";

type DialogSize = "sm" | "md" | "lg" | "xl" | "2xl";

const SIZE_CLS: Record<DialogSize, string> = {
  sm: "max-w-md",
  md: "max-w-lg",
  lg: "max-w-xl",
  xl: "max-w-2xl",
  "2xl": "max-w-3xl",
};

export function Dialog({
  open,
  onOpenChange,
  children,
  size = "md",
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  children: React.ReactNode;
  /** Visual width breakpoint. Default `md` matches every prior caller;
   * SettingsDialog overrides to `xl` to fit the tabbed format picker. */
  size?: DialogSize;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-100 flex items-center justify-center p-4"
      onClick={() => onOpenChange(false)}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={`relative z-10 w-full ${SIZE_CLS[size]} rounded-md border border-border bg-card text-card-foreground p-5 shadow-xl max-h-[90vh] overflow-y-auto`}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({ children }: { children: React.ReactNode }) {
  return <div className="mb-3">{children}</div>;
}

export function DialogTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-base font-semibold">{children}</h2>;
}

export function DialogDescription({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`text-sm text-foreground/80 mt-2 leading-relaxed ${className}`}>{children}</div>
  );
}

export function DialogFooter({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`mt-4 flex justify-end gap-2 flex-wrap [&>button]:min-h-11 sm:[&>button]:min-h-0 ${className}`}
    >
      {children}
    </div>
  );
}
