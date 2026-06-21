"use client";

/**
 * Image renderer: native `<img>` from /api/file, centered on a muted
 * checkerboard-ish surface so transparency is visible. Click toggles 1:1 vs
 * fit. Path-based (the live file), distinct from the content-addressed /images
 * gallery.
 */

import { rawUrl } from "@/lib/file-viewer/client";
import type { FileMeta } from "@/lib/file-viewer/types";
import { useState } from "react";

export default function ImageRenderer({ meta, path }: { meta: FileMeta; path: string }) {
  const [actual, setActual] = useState(false);
  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-auto bg-muted/20 p-4">
      <button
        type="button"
        onClick={() => setActual((a) => !a)}
        title={actual ? "Fit to view" : "View actual size"}
        className="cursor-zoom-in focus-visible:outline-none"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={rawUrl(path)}
          alt={meta.relPath.split("/").pop() ?? "image"}
          className={actual ? "max-w-none" : "max-h-[78vh] max-w-full object-contain"}
        />
      </button>
    </div>
  );
}
