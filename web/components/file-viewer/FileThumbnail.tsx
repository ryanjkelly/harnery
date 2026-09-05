"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { loadThumbnail, type ThumbnailPriority } from "./thumbnail-loader";

export function FileThumbnail(props: { relPath: string; version: string; children: ReactNode }) {
  // A source change disposes the previous object URL before loading the replacement.
  return <Thumbnail key={`${props.relPath}\0${props.version}`} {...props} />;
}

function Thumbnail({
  relPath,
  version,
  children,
}: {
  relPath: string;
  version: string;
  children: ReactNode;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const objectUrl = useRef<string | null>(null);
  const deadline = useRef<number | null>(null);
  const complete = useRef(false);
  const [priority, setPriority] = useState<ThumbnailPriority | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    if (typeof IntersectionObserver === "undefined") return;
    let visible = false;
    let nearby = false;
    const update = () =>
      setPriority(
        document.visibilityState === "hidden"
          ? null
          : visible
            ? "visible"
            : nearby
              ? "prefetch"
              : null,
      );
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      update();
    });
    const prefetch = new IntersectionObserver(
      ([entry]) => {
        nearby = entry.isIntersecting;
        update();
      },
      { root: target.closest('[aria-label="Folder contents"]'), rootMargin: "0px 0px 240px 0px" },
    );
    observer.observe(target);
    prefetch.observe(target);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect();
      prefetch.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  useEffect(() => {
    if (!priority) {
      // Keep decoded images only in or just below the viewport, even in very long lists.
      if (objectUrl.current) {
        URL.revokeObjectURL(objectUrl.current);
        objectUrl.current = null;
        complete.current = false;
        deadline.current = null;
        setSrc(null);
      }
      return;
    }
    if (complete.current) return;
    deadline.current ??= Date.now() + 30_000;
    const controller = new AbortController();
    void loadThumbnail(relPath, version, controller.signal, deadline.current, fetch, priority)
      .then((blob) => {
        if (controller.signal.aborted) return;
        complete.current = true;
        if (blob) {
          objectUrl.current = URL.createObjectURL(blob);
          setSrc(objectUrl.current);
        }
      })
      .catch(() => {
        // Leaving the viewport can resume within the original budget; failures cannot.
        if (!controller.signal.aborted) complete.current = true;
      });
    return () => controller.abort();
  }, [relPath, version, priority]);

  return (
    <span
      ref={container}
      data-thumbnail-path={relPath}
      data-thumbnail-priority={priority ?? "offscreen"}
      className="flex size-full items-center justify-center"
    >
      {src ? (
        // biome-ignore lint/performance/noImgElement: server-generated WebP is already bounded and optimized.
        <img
          src={src}
          alt=""
          decoding="async"
          className="size-full object-contain"
          onError={() => {
            if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
            objectUrl.current = null;
            setSrc(null);
          }}
        />
      ) : (
        children
      )}
    </span>
  );
}
