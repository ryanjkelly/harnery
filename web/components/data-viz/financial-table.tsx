/**
 * FinancialTable is the canonical dense-table primitive. It includes zebra striping
 * (odd:bg-muted/40), hover transition (hover:bg-muted/60), and the
 * border-separate setup that lets cell borders compose with the row
 * highlights without collapse-mode artifacts.
 */

import type { ComponentPropsWithoutRef } from "react";

import { cn } from "@/lib/cn";

export function FinancialTable({
  className,
  ...props
}: ComponentPropsWithoutRef<"table">) {
  return (
    <table
      className={cn(
        "w-full text-sm border-separate border-spacing-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Zebra-striped body row with hover transition. `group` lets descendant cells
 * opt into `group-hover:` styling. odd:/even: variants map to :nth-child and
 * work without JS.
 */
export function FinancialTableRow({
  className,
  ...props
}: ComponentPropsWithoutRef<"tr">) {
  return (
    <tr
      className={cn(
        "group transition-colors odd:bg-muted/40 hover:bg-muted/60",
        className,
      )}
      {...props}
    />
  );
}

export function FinancialTableTotalRow({
  className,
  ...props
}: ComponentPropsWithoutRef<"tr">) {
  return (
    <tr className={cn("border-t-2 border-border", className)} {...props} />
  );
}
