"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { acquireThumbnail, type ThumbnailLease } from "./thumbnail-cache";
import type { ThumbnailPriority } from "./thumbnail-loader";

export function FileThumbnail(props: { relPath: string; version: string; children: ReactNode }) {
  // Source versions and explicit refresh generations cannot reuse the previous image.
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
  const lease = useRef<ThumbnailLease | null>(null);
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

  useEffect(() => {
    if (!priority) {
      // Released cards share a short-lived, bounded cache for scrolling and Back.
      complete.current = false;
      deadline.current = null;
      setSrc(null);
      return;
    }
    if (complete.current) return;
    setSrc(null);
    deadline.current ??= Date.now() + 30_000;
    let canceled = false;
    const acquired = acquireThumbnail(relPath, version, deadline.current, priority);
    lease.current = acquired;
    void acquired.ready
      .then((image) => {
        if (canceled) return;
        complete.current = true;
        if (image) setSrc(image.url);
      })
      .catch(() => {
        // Leaving the viewport can resume within the original budget; failures cannot.
        if (!canceled) complete.current = true;
      });
    return () => {
      canceled = true;
      acquired.release();
      lease.current = null;
      complete.current = false;
    };
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
            lease.current?.invalidate();
            lease.current?.release();
            lease.current = null;
            setSrc(null);
          }}
        />
      ) : (
        children
      )}
    </span>
  );
}
