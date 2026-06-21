"use client";

/**
 * The viewer shell, generalized from the /images lightbox (DetailOverlay).
 * First lazy chunk: loaded on first open() / first /files visit, so the base
 * bundle stays tiny. Owns the /api/file/meta fetch + the meta-level
 * failure states, the header chrome, the keyboard + mobile-gesture model, focus
 * trap, and body-scroll lock. The body is the category-dispatched
 * RendererRegistry.
 */

import { type FetchResult, fetchMeta, rawUrl } from "@/lib/file-viewer/client";
import type { FileMeta, FileViewerState } from "@/lib/file-viewer/types";
import { Check, Copy, Download, ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { RendererRegistry } from "./RendererRegistry";
import {
  DeniedState,
  LoadingState,
  NotFoundState,
  TransportErrorState,
  UnresolvableState,
} from "./ViewerStates";

const MAX_KEY = "harnery.fileviewer.maximized";

export default function FileViewerOverlay({
  state,
  onClose,
  onNavigate,
}: {
  state: FileViewerState;
  onClose: () => void;
  onNavigate: (index: number) => void;
}) {
  const { path, sequence, index } = state;
  const inSequence = sequence.length > 1;
  const hasPrev = inSequence && index > 0;
  const hasNext = inSequence && index < sequence.length - 1;

  // Size preference, persisted across opens + reloads, like the image lightbox.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    try {
      setMaximized(localStorage.getItem(MAX_KEY) === "1");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleMaximized = useCallback(() => {
    setMaximized((m) => {
      const next = !m;
      try {
        localStorage.setItem(MAX_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  // Meta fetch, re-runs when the path changes (sequence nav / replace-in-place).
  const [meta, setMeta] = useState<FetchResult<FileMeta> | null>(null);
  const loadMeta = useCallback(() => {
    setMeta(null);
    fetchMeta(path).then(setMeta);
  }, [path]);
  useEffect(() => {
    loadMeta();
  }, [loadMeta]);

  // Keyboard: Esc close + f maximize always; ←/→ only in sequence mode.
  const goPrev = useCallback(() => {
    if (hasPrev) onNavigate(index - 1);
  }, [hasPrev, index, onNavigate]);
  const goNext = useCallback(() => {
    if (hasNext) onNavigate(index + 1);
  }, [hasNext, index, onNavigate]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "f" || e.key === "F") {
        // Don't hijack `f` while the user is typing in an input/textarea.
        const el = document.activeElement;
        if (el && /^(input|textarea|select)$/i.test(el.tagName)) return;
        toggleMaximized();
      } else if (inSequence && e.key === "ArrowLeft") goPrev();
      else if (inSequence && e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, toggleMaximized, inSequence, goPrev, goNext]);

  // Body-scroll lock + focus trap (correctness, not polish). Restore the
  // previously-focused element on close.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const prevFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onTrap = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onTrap);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onTrap);
      prevFocus?.focus?.();
    };
  }, []);

  // Mobile gestures on the body surface: swipe-down closes (and restores from
  // maximized first), swipe-up maximizes; horizontal flicks navigate in
  // sequence mode. Mirrors the image lightbox's ladder.
  const touchRef = useRef<{ x: number; y: number } | null>(null);
  const SWIPE = 45;
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      touchRef.current = null;
      return;
    }
    const t = e.touches[0]!;
    touchRef.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touchRef.current;
    touchRef.current = null;
    const t = e.changedTouches[0];
    if (!start || !t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (Math.max(adx, ady) < SWIPE) return;
    if (adx > ady) {
      if (!inSequence) return;
      if (dx < 0) goNext();
      else goPrev();
    } else if (dy < 0) {
      if (!maximized) toggleMaximized();
    } else if (maximized) {
      toggleMaximized();
    } else {
      onClose();
    }
  };

  const filename = path.split("/").pop() ?? path;
  const m = meta?.ok ? meta.data : null;
  const downloadName = filename;

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop click-to-close is a mouse convenience; Esc handles keyboard (wired above).
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center bg-black/70 ${maximized ? "p-2" : "p-4 sm:p-6"}`}
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops backdrop-close on inner clicks; not itself a control, and Esc handles keyboard close (wired above). */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        aria-label={`File viewer: ${filename}`}
        className={`flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl outline-none ${
          maximized ? "h-[97vh] w-[98vw] max-w-none" : "h-[88vh] w-full max-w-5xl"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <span className="truncate font-mono text-sm text-foreground" title={path}>
            {filename}
          </span>
          <CopyButton value={m?.relPath ?? path} title="Copy path" />
          {m && (
            <span className="ml-1 hidden items-center gap-2 text-xs text-muted-foreground sm:flex">
              <span>{formatSize(m.size)}</span>
              <span>·</span>
              <span>{m.category}</span>
            </span>
          )}
          {inSequence && (
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {index + 1} / {sequence.length}
            </span>
          )}
          <div className={`flex items-center gap-1 ${inSequence ? "" : "ml-auto"}`}>
            <IconLink
              href={rawUrl(path)}
              target="_blank"
              title="Open raw in new tab"
              label={`Open ${filename} raw in new tab`}
            >
              <ExternalLink className="size-4" />
            </IconLink>
            <IconLink
              href={rawUrl(path, { download: downloadName })}
              download={downloadName}
              title="Download"
              label={`Download ${filename}`}
            >
              <Download className="size-4" />
            </IconLink>
            <button
              type="button"
              onClick={toggleMaximized}
              className="rounded border border-border p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              aria-label={maximized ? "Restore default size" : "Maximize"}
              title={maximized ? "Restore default size (f)" : "Maximize (f)"}
            >
              {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              aria-label="Close"
              title="Close (Esc)"
            >
              <X className="size-4" />
            </button>
          </div>
        </header>

        <div
          data-viewer-surface
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          className="relative flex min-h-0 flex-1 flex-col bg-background/40"
        >
          {hasPrev && <NavArrow dir="prev" onClick={goPrev} />}
          {hasNext && <NavArrow dir="next" onClick={goNext} />}
          <Body path={path} meta={meta} onRetry={loadMeta} />
        </div>
      </div>
    </div>
  );
}

function Body({
  path,
  meta,
  onRetry,
}: {
  path: string;
  meta: FetchResult<FileMeta> | null;
  onRetry: () => void;
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
  return <RendererRegistry meta={meta.data} path={path} />;
}

/* ── small shared pieces ─────────────────────────────────────────────────── */

function NavArrow({ dir, onClick }: { dir: "prev" | "next"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={dir === "prev" ? "Previous" : "Next"}
      className={`absolute top-1/2 z-10 -translate-y-1/2 ${dir === "prev" ? "left-2" : "right-2"} flex size-9 items-center justify-center rounded-full bg-background/70 text-foreground backdrop-blur-md transition hover:bg-background`}
    >
      {dir === "prev" ? "‹" : "›"}
    </button>
  );
}

function IconLink({
  href,
  children,
  title,
  label,
  target,
  download,
}: {
  href: string;
  children: React.ReactNode;
  title: string;
  label: string;
  target?: string;
  download?: string;
}) {
  return (
    <a
      href={href}
      title={title}
      aria-label={label}
      target={target}
      rel={target === "_blank" ? "noopener noreferrer" : undefined}
      download={download}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center justify-center rounded border border-border p-1 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
    >
      {children}
    </a>
  );
}

function CopyButton({ value, title }: { value: string; title: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
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
