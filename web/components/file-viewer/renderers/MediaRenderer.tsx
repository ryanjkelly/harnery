"use client";

/**
 * Audio / video / PDF renderers: native elements pointed at /api/file.
 * Audio + video rely on the raw route's Range/206 support for scrubbing
 * (verified in Phase 0). PDF uses a native sandboxed `<iframe>` (no pdf.js in
 * v1). The raw route serves PDF WITHOUT the CSP `sandbox` header
 * (Chrome's PDF viewer document is blocked by it), so the iframe's own `sandbox`
 * attr is the containment.
 */

import { useContext, useEffect, useRef, useState } from "react";
import { rawUrl } from "@/lib/file-viewer/client";
import type { FileMeta } from "@/lib/file-viewer/types";
import {
  VideoAutoplayToggle,
  VideoPlaybackContext,
  VideoSelectionContext,
  videoAutoplayEnabled,
} from "../video-playback";

export function AudioRenderer({ path }: { meta: FileMeta; path: string }) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-8">
      {/* biome-ignore lint/a11y/useMediaCaption: agent-produced/asset audio has no caption track */}
      <audio controls src={rawUrl(path)} className="w-full max-w-xl">
        Your browser doesn&apos;t support the audio element.
      </audio>
    </div>
  );
}

export function VideoRenderer({ meta, path }: { meta: FileMeta; path: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const selection = useContext(VideoSelectionContext);
  const reportPlayback = useContext(VideoPlaybackContext);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    reportPlayback({ path, playing: false });
    return () => reportPlayback(null);
  }, [path, reportPlayback]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let cancelled = false;
    if (selection?.path === path && selection.action === "pause") {
      element.pause();
    } else if (
      (selection?.path === path && selection.action === "play") ||
      videoAutoplayEnabled()
    ) {
      setBlocked(false);
      void element
        .play()
        .then(() => {
          if (cancelled) element.pause();
        })
        .catch(() => {
          if (!cancelled) setBlocked(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [path, selection]);
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/20">
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-b border-border px-4 py-2">
        {blocked && (
          <span role="status" className="text-xs text-muted-foreground">
            Press Play to start this video.
          </span>
        )}
        <VideoAutoplayToggle />
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <video
          ref={video}
          controls
          playsInline
          preload="metadata"
          onPlay={() => {
            setBlocked(false);
            reportPlayback({ path, playing: true });
          }}
          onPause={() => reportPlayback({ path, playing: false })}
          onEnded={() => reportPlayback({ path, playing: false })}
          onEmptied={() => reportPlayback({ path, playing: false })}
          src={rawUrl(path)}
          className="max-h-full max-w-full"
        >
          <track kind="captions" />
          {meta.relPath}
        </video>
      </div>
    </div>
  );
}

export function PdfRenderer({ meta, path }: { meta: FileMeta; path: string }) {
  return (
    // No `sandbox` attribute, by necessity: Chrome's built-in PDF viewer is an
    // internal chrome-extension document that refuses to instantiate inside a
    // sandboxed frame — any sandbox value yields net::(blocked:other) + the
    // "This page has been blocked by Chrome" overlay. (Headless Chromium can't
    // catch this: its build omits the PDF plugin, so a sandboxed PDF iframe just
    // paints blank instead of blocking.) Dropping the sandbox is safe because
    // the framed bytes are served `application/pdf` + `nosniff`, so Chrome hands
    // them to PDFium and NEVER instantiates a scriptable same-origin HTML
    // document that could reach the dashboard — sandbox or not, there is nothing
    // to contain. The raw route likewise omits the CSP `sandbox` header for PDFs
    // for exactly this reason (see baseHeaders in lib/file-routes.ts).
    <iframe
      src={rawUrl(path)}
      title={meta.relPath}
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}
