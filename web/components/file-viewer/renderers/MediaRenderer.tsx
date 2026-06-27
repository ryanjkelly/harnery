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
