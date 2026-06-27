"use client";

/**
 * Audio / video / PDF renderers: native elements pointed at /api/file.
 * Audio + video rely on the raw route's Range/206 support for scrubbing
 * (verified in Phase 0). PDF uses a native sandboxed `<iframe>` (no pdf.js in
 * v1). The raw route serves PDF WITHOUT the CSP `sandbox` header
 * (Chrome's PDF viewer document is blocked by it), so the iframe's own `sandbox`
 * attr is the containment.
 */

import { rawUrl } from "@/lib/file-viewer/client";
import type { FileMeta } from "@/lib/file-viewer/types";

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
  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-muted/20 p-4">
      <video controls src={rawUrl(path)} className="max-h-[78vh] max-w-full">
        <track kind="captions" />
        {meta.relPath}
      </video>
    </div>
  );
}

export function PdfRenderer({ meta, path }: { meta: FileMeta; path: string }) {
  return (
    <iframe
      src={rawUrl(path)}
      title={meta.relPath}
      // allow-same-origin is REQUIRED: Chrome's PDF viewer is an internal
      // chrome-extension document that won't load into an opaque (sandboxed-away)
      // origin — withholding it yields "This page has been blocked by Chrome",
      // not containment. Safe here because the route serves application/pdf +
      // nosniff, so the frame renders in PDFium, never as scriptable same-origin
      // HTML. allow-scripts is omitted (the viewer UI runs in the extension
      // context, and allow-scripts + allow-same-origin is the escape combo);
      // allow-downloads powers the toolbar's Save button.
      sandbox="allow-same-origin allow-popups allow-forms allow-downloads"
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}
