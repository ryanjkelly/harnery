"use client";

import { Tooltip } from "@/components/ui/tooltip";

export function StorageHelp({
  children,
  help,
  name,
  className = "",
  side = "top",
}: {
  children: React.ReactNode;
  help: React.ReactNode;
  name: string;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <Tooltip content={help} side={side} className="max-w-sm">
      <button
        type="button"
        onClick={(event) => event.stopPropagation()}
        data-storage-help={name}
        className={`inline-flex min-h-6 max-w-full cursor-help appearance-none items-center border-x-0 border-t-0 border-b border-dotted border-current/50 bg-transparent p-0 text-left font-inherit text-inherit whitespace-normal break-words outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}
