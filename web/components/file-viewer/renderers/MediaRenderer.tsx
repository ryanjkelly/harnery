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
      // The PDF document loads in the iframe's own sandbox; allow-scripts is
      // required for the browser's built-in PDF viewer UI, allow-same-origin is
      // NOT granted so it can't reach the dashboard's origin.
      sandbox="allow-scripts allow-popups allow-forms"
      className="h-full min-h-0 w-full flex-1 border-0 bg-white"
    />
  );
}
