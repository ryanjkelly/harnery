"use client";

/**
 * Category → renderer dispatch. Each renderer is a `React.lazy` import
 * so heavy engines (Shiki, react-markdown, yaml) stay in their own chunks,
 * loaded on first use of that type. Text-family categories fetch /api/file/text
 * here (capped, with a truncation banner); media categories (image/svg/audio/
 * video/pdf) render native elements off the raw route; archive (Phase 3) +
 * binary degrade to a download card.
 */

import { type FetchResult, fetchText, rawUrl } from "@/lib/file-viewer/client";
import type { FileMeta, FileText } from "@/lib/file-viewer/types";
import { Component, type ReactNode, Suspense, lazy, useCallback, useEffect, useState } from "react";
import {
  DownloadCard,
  LoadingState,
  RenderErrorState,
  TransportErrorState,
  TruncationBanner,
} from "./ViewerStates";

const TextRenderer = lazy(() => import("./renderers/TextRenderer"));
const CodeRenderer = lazy(() => import("./renderers/CodeRenderer"));
const MarkdownRenderer = lazy(() => import("./renderers/MarkdownRenderer"));
const JsonRenderer = lazy(() => import("./renderers/JsonRenderer"));
const YamlRenderer = lazy(() => import("./renderers/YamlRenderer"));
const ImageRenderer = lazy(() => import("./renderers/ImageRenderer"));
const SvgRenderer = lazy(() => import("./renderers/SvgRenderer"));
const AudioRenderer = lazy(() =>
  import("./renderers/MediaRenderer").then((m) => ({ default: m.AudioRenderer })),
);
const VideoRenderer = lazy(() =>
  import("./renderers/MediaRenderer").then((m) => ({ default: m.VideoRenderer })),
);
const PdfRenderer = lazy(() =>
  import("./renderers/MediaRenderer").then((m) => ({ default: m.PdfRenderer })),
);
const CsvRenderer = lazy(() => import("./renderers/CsvRenderer"));
const HtmlRenderer = lazy(() => import("./renderers/HtmlRenderer"));
const ArchiveRenderer = lazy(() => import("./renderers/ArchiveRenderer"));

/** Media + structured categories rendered off a path (no /text fetch). Each
 * takes { meta, path }. (Archive fetches its own listing endpoint.) */
const PATH_RENDERERS: Record<string, React.ComponentType<{ meta: FileMeta; path: string }>> = {
  image: ImageRenderer,
  svg: SvgRenderer,
  audio: AudioRenderer,
  video: VideoRenderer,
  pdf: PdfRenderer,
  archive: ArchiveRenderer,
};

/** Categories whose body is fetched via /api/file/text. csv + html still ride
 * the /text fetch but get richer renderers (papaparse table / source+preview)
 * instead of the plain text fallback. */
const TEXT_FAMILY = new Set(["markdown", "code", "json", "yaml", "text", "csv", "html"]);

function TextFamily({ meta, path }: { meta: FileMeta; path: string }) {
  const [res, setRes] = useState<FetchResult<FileText> | null>(null);
  const load = useCallback(() => {
    setRes(null);
    fetchText(path).then(setRes);
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);

  if (res === null) return <LoadingState path={meta.relPath} />;
  if (!res.ok) {
    if (res.code === "transport" || res.code === "bad_json" || res.status >= 500) {
      return <TransportErrorState onRetry={load} />;
    }
    // denied / secret_signature / not_text / etc. surfaced after meta succeeded
    // (e.g. the /text served-bytes secret rescan). Show the reason, offer the
    // raw/download escape hatch.
    return (
      <DownloadCard
        relPath={meta.relPath}
        rawHref={rawUrl(path)}
        downloadHref={rawUrl(path, { download: meta.relPath.split("/").pop() })}
        reason={
          res.code === "secret_signature"
            ? "Blocked: content carries a secret signature"
            : `Can't preview (${res.code})`
        }
      />
    );
  }

  const file = res.data;
  // text + csv self-virtualize, and html renders into an iframe: all three own
  // their own inner scroll and need a flex-BOUNDED (non-scrolling) parent so their
  // height resolves. An overflow-auto wrapper leaves the child's flex-1 unbounded —
  // the text/csv virtualizer would render every row, and the html iframe collapses
  // to its ~150px intrinsic height (the sliver + black-void bug). Prose renderers
  // (markdown/json/yaml) want the scrolling block instead.
  const selfScrolls =
    meta.category === "text" || meta.category === "csv" || meta.category === "html";
  const Renderer =
    meta.category === "markdown"
      ? MarkdownRenderer
      : meta.category === "json"
        ? JsonRenderer
        : meta.category === "yaml"
          ? YamlRenderer
          : meta.category === "csv"
            ? CsvRenderer
            : meta.category === "html"
              ? HtmlRenderer
              : meta.category === "code"
                ? CodeRenderer
                : TextRenderer;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {file.truncated && <TruncationBanner lines={file.lines} />}
      <div className={`min-h-0 flex-1 ${selfScrolls ? "flex flex-col" : "overflow-auto"}`}>
        <RenderErrorBoundary key={path} relPath={meta.relPath}>
          <Suspense fallback={<LoadingState path={meta.relPath} />}>
            <Renderer file={file} />
          </Suspense>
        </RenderErrorBoundary>
      </div>
    </div>
  );
}

export function RendererRegistry({ meta, path }: { meta: FileMeta; path: string }) {
  if (TEXT_FAMILY.has(meta.category)) {
    return <TextFamily meta={meta} path={path} />;
  }
  const PathRenderer = PATH_RENDERERS[meta.category];
  if (PathRenderer) {
    return (
      <RenderErrorBoundary key={path} relPath={meta.relPath}>
        <Suspense fallback={<LoadingState path={meta.relPath} />}>
          <PathRenderer meta={meta} path={path} />
        </Suspense>
      </RenderErrorBoundary>
    );
  }
  // binary → download card (never a broken view).
  return (
    <DownloadCard
      relPath={meta.relPath}
      rawHref={rawUrl(path)}
      downloadHref={rawUrl(path, { download: meta.relPath.split("/").pop() })}
      reason="Binary file: download to view"
    />
  );
}

/* ── render-error boundary ("Render error" state) ────────────────────────── */

class RenderErrorBoundary extends Component<
  { children: ReactNode; relPath: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <RenderErrorState message={this.state.error.message} />;
    }
    return this.props.children;
  }
}
