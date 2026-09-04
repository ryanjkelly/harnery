"use client";

/**
 * Full-page file viewer for `/files/view?path=…` — same meta → registry path as
 * the overlay/pane, without the modal chrome. Lets HTML open in a real browser
 * tab with Source | Preview while `/api/file` stays non-navigable text/plain.
 */

import { Check, Copy, Download, ExternalLink, Eye, FileText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type FetchResult,
  fetchMeta,
  isHtmlPreviewPath,
  rawUrl,
  sandboxedRenderUrl,
} from "@/lib/file-viewer/client";
import type { FileMeta } from "@/lib/file-viewer/types";
import { RendererRegistry } from "./RendererRegistry";
import { RevealInFileManagerButton } from "./RevealInFileManagerButton";
import {
  DeniedState,
  LoadingState,
  NotFoundState,
  TransportErrorState,
  UnresolvableState,
} from "./ViewerStates";

export function StandaloneFileViewer({
  path,
  initialMode,
}: {
  path: string | null;
  /** Seed for HtmlRenderer's Source | Preview toggle. */
  initialMode: "source" | "preview";
}) {
  const [meta, setMeta] = useState<FetchResult<FileMeta> | null>(null);
  const load = useCallback(() => {
    if (path === null) {
      setMeta(null);
      return;
    }
    setMeta(null);
    fetchMeta(path).then(setMeta);
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);

  if (path === null) return <MissingPath />;

  const filename = path.split("/").pop() ?? path;
  const m = meta?.ok ? meta.data : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="truncate font-mono text-sm text-foreground" title={path}>
          {filename}
        </span>
        <CopyButton value={m?.relPath ?? path} />
        {m && (
          <span className="ml-1 hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
            <span>{formatSize(m.size)}</span>
            <span>·</span>
            <span>{m.category}</span>
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {m && <RevealInFileManagerButton path={m.relPath} />}
          {isHtmlPreviewPath(path) && (
            <IconLink
              href={sandboxedRenderUrl(path)}
              target="_blank"
              title="Open rendered page in new tab"
            >
              <Eye className="size-4" />
            </IconLink>
          )}
          <IconLink href={rawUrl(path)} target="_blank" title="Open raw in new tab">
            <ExternalLink className="size-4" />
          </IconLink>
          <IconLink
            href={rawUrl(path, { download: filename })}
            download={filename}
            title="Download"
          >
            <Download className="size-4" />
          </IconLink>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col bg-background/40">
        <Body path={path} meta={meta} onRetry={load} initialMode={initialMode} />
      </div>
    </div>
  );
}

function Body({
  path,
  meta,
  onRetry,
  initialMode,
}: {
  path: string;
  meta: FetchResult<FileMeta> | null;
  onRetry: () => void;
  initialMode: "source" | "preview";
}) {
  if (meta === null) return <LoadingState path={path} />;
  if (!meta.ok) {
    switch (meta.code) {
      case "denied":
      case "secret_signature":
        return <DeniedState relPath={path} />;
      case "ambiguous_path":
      case "unresolvable":
      case "invalid_path":
        return <UnresolvableState input={path} />;
      case "not_found":
      case "not_file":
        return <NotFoundState relPath={path} />;
      default:
        return <TransportErrorState onRetry={onRetry} />;
    }
  }
  return <RendererRegistry meta={meta.data} path={path} htmlInitialMode={initialMode} />;
}

function MissingPath() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <FileText className="size-8 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">
        Missing <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">?path=</code>.
        Deep-link a file with{" "}
        <code className="rounded bg-muted/60 px-1 py-0.5 font-mono text-xs">
          /files/view?path=…
        </code>
        .
      </p>
    </div>
  );
}

function IconLink({
  href,
  children,
  title,
  target,
  download,
}: {
  href: string;
  children: React.ReactNode;
  title: string;
  target?: string;
  download?: string;
}) {
  return (
    <a
      href={href}
      title={title}
      aria-label={title}
      target={target}
      rel={target === "_blank" ? "noopener noreferrer" : undefined}
      download={download}
      className="inline-flex items-center justify-center rounded border border-border p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      {children}
    </a>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy path"
      aria-label="Copy path"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* silent */
        }
      }}
      className="inline-flex items-center justify-center rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
