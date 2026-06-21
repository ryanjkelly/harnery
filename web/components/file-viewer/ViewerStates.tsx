"use client";

/**
 * The failure-state matrix as small presentational components. The overlay
 * body is NEVER empty, never a raw JSON blob, never dangerouslySetInnerHTML.
 * Each state names its trigger and the actions it offers.
 */

import { AlertTriangle, Ban, Download, FileQuestion, FileX, Lock, RefreshCw } from "lucide-react";

function StateShell({
  icon,
  title,
  detail,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-muted-foreground/70">{icon}</div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {detail && (
        <p className="max-w-md break-all font-mono text-[11px] text-muted-foreground">{detail}</p>
      )}
      {children}
    </div>
  );
}

export function LoadingState({ path }: { path: string }) {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-8">
      <RefreshCw className="size-5 animate-spin text-muted-foreground/60" />
      <p className="max-w-md break-all font-mono text-[11px] text-muted-foreground">{path}</p>
    </div>
  );
}

export function DeniedState({ relPath }: { relPath: string }) {
  return (
    <StateShell
      icon={<Lock className="size-7" />}
      title="Blocked by security policy"
      detail={relPath}
    />
  );
}

export function UnresolvableState({ input }: { input: string }) {
  return (
    <StateShell icon={<Ban className="size-7" />} title="Couldn't resolve path" detail={input} />
  );
}

export function NotFoundState({ relPath }: { relPath: string }) {
  return (
    <StateShell
      icon={<FileX className="size-7" />}
      title="File not found or moved"
      detail={relPath}
    />
  );
}

export function TransportErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <StateShell icon={<AlertTriangle className="size-7" />} title="Couldn't load file">
      <button
        type="button"
        onClick={onRetry}
        className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-foreground hover:bg-muted/60"
      >
        <RefreshCw className="size-3.5" /> Retry
      </button>
    </StateShell>
  );
}

export function RenderErrorState({ message }: { message: string }) {
  return (
    <StateShell
      icon={<AlertTriangle className="size-7 text-amber-500/80" />}
      title="Couldn't render this file"
      detail={message}
    />
  );
}

export function DownloadCard({
  relPath,
  rawHref,
  downloadHref,
  reason,
}: {
  relPath: string;
  rawHref: string;
  downloadHref: string;
  reason: string;
}) {
  return (
    <StateShell icon={<FileQuestion className="size-7" />} title={reason} detail={relPath}>
      <div className="mt-1 flex items-center gap-2">
        <a
          href={downloadHref}
          className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-foreground hover:bg-muted/60"
        >
          <Download className="size-3.5" /> Download
        </a>
        <a
          href={rawHref}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60"
        >
          Open raw
        </a>
      </div>
    </StateShell>
  );
}

/** Persistent truncation banner shown above a capped preview, never silent. */
export function TruncationBanner({ lines }: { lines: number }) {
  return (
    <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
      Showing first {lines.toLocaleString()} lines. Download for the full file.
    </div>
  );
}
