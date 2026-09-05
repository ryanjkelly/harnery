"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { loadThumbnail } from "./thumbnail-loader";

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
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const target = container.current;
    if (!target) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    },
    [],
  );

  useEffect(() => {
    if (!visible || complete.current) return;
    deadline.current ??= Date.now() + 30_000;
    const controller = new AbortController();
    void loadThumbnail(relPath, version, controller.signal, deadline.current)
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
  }, [relPath, version, visible]);

  return (
    <span ref={container} className="flex size-full items-center justify-center">
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
