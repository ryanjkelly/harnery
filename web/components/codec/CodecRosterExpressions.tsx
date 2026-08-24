"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./codecRoster.module.css";

interface CodecRosterExpressionsProps {
  packId: string;
  packVersion: string;
  expressions: readonly string[];
  initiallyLoad?: boolean;
}

const LOAD_MARGIN = "600px 0px";

/**
 * Keep every expression label searchable while assigning portrait URLs only
 * when the containing pack approaches the viewport.
 */
export function CodecRosterExpressions({
  packId,
  packVersion,
  expressions,
  initiallyLoad = false,
}: CodecRosterExpressionsProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(initiallyLoad);

  useEffect(() => {
    if (shouldLoad) return;
    const grid = gridRef.current;
    if (!grid || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: LOAD_MARGIN },
    );
    observer.observe(grid);
    return () => observer.disconnect();
  }, [shouldLoad]);

  return (
    <div
      ref={gridRef}
      className={styles.expressionGrid}
      data-codec-images={shouldLoad ? "loaded" : "deferred"}
      aria-busy={!shouldLoad}
    >
      {expressions.map((expression) => (
        <figure data-codec-expression={expression} className={styles.expression} key={expression}>
          {shouldLoad ? (
            // biome-ignore lint/performance/noImgElement: runtime packs are already optimized WebP assets
            <img
              src={`/api/codec-pack/${packId}/${expression}?v=${packVersion}`}
              alt={`${packId} character with ${expression} expression`}
              width={512}
              height={512}
              loading="eager"
              fetchPriority={initiallyLoad ? "high" : "low"}
              decoding="async"
            />
          ) : (
            <span className={styles.expressionPlaceholder} aria-hidden />
          )}
          <figcaption>{expression}</figcaption>
        </figure>
      ))}
    </div>
  );
}
