import type * as React from "react";

import { cn } from "@/lib/cn";

/**
 * Plain data table parts with the dashboard's standard frame, header and
 * cell spacing. Compose them like HTML table elements:
 *
 *   <Table>
 *     <TableHead><tr><Th>Process</Th><Th>Ports</Th></tr></TableHead>
 *     <tbody>
 *       <Tr><Td mono>{pid}</Td><Td>{ports}</Td></Tr>
 *     </tbody>
 *   </Table>
 *
 * The frame scrolls horizontally on narrow screens instead of overflowing
 * the page. Virtualized tables keep their own components (see the
 * Ctrl+F rule in the repo instructions).
 */
export function Table({
  className,
  frameClassName,
  ...props
}: React.ComponentProps<"table"> & { frameClassName?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-border", frameClassName)}>
      <table className={cn("w-full text-sm", className)} {...props} />
    </div>
  );
}

export function TableHead({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      className={cn("bg-muted/40 text-left text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export function Th({ className, ...props }: React.ComponentProps<"th">) {
  return <th className={cn("px-3 py-2 font-medium", className)} {...props} />;
}

export function Tr({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr className={cn("border-t border-border align-top", className)} {...props} />;
}

export function Td({
  className,
  mono = false,
  ...props
}: React.ComponentProps<"td"> & { mono?: boolean }) {
  return <td className={cn("px-3 py-2", mono && "font-mono text-xs", className)} {...props} />;
}

/**
 * Label/value pairs in a two-column grid ("Started", "Owner", "Port").
 * Pass `items`; a falsy value is skipped so callers can list optional fields
 * without conditionals.
 */
export function KeyValueList({
  items,
  className,
}: {
  items: Array<[label: React.ReactNode, value: React.ReactNode] | null | false | undefined>;
  className?: string;
}) {
  return (
    <dl className={cn("grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-sm", className)}>
      {items.filter(Boolean).map((item, index) => {
        const [label, value] = item as [React.ReactNode, React.ReactNode];
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: pairs are positional and never reorder.
          <div key={index} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words">{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}
