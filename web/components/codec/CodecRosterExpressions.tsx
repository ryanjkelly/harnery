"use client";

import { useEffect, useRef, useState } from "react";

import styles from "./codecRoster.module.css";

export interface RosterExpressionAsset {
  label: string;
  source: string;
}

interface CodecRosterExpressionsProps {
  packId: string;
  packVersion: string;
  expressions: readonly RosterExpressionAsset[];
  initiallyLoad?: boolean;
  persistent?: boolean;
}

const LOAD_MARGIN = "1200px 0px";

/**
 * Keep every expression label searchable while assigning portrait URLs only
 * when the containing pack approaches the viewport.
 */
export function CodecRosterExpressions({
  packId,
  packVersion,
  expressions,
  initiallyLoad = false,
  persistent = false,
}: CodecRosterExpressionsProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(initiallyLoad || persistent);

  useEffect(() => {
    if (persistent) {
      setShouldLoad(true);
      return;
    }
    const grid = gridRef.current;
    if (!grid || typeof IntersectionObserver === "undefined") {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setShouldLoad(entries.some((entry) => entry.isIntersecting));
      },
      { rootMargin: LOAD_MARGIN },
    );
    observer.observe(grid);
    return () => observer.disconnect();
  }, [persistent]);

  return (
    <div
      ref={gridRef}
      className={styles.expressionGrid}
      data-codec-images={persistent ? "persistent" : shouldLoad ? "loaded" : "deferred"}
      aria-busy={!shouldLoad}
    >
      {expressions.map((expression) => (
        <figure
          data-codec-expression={expression.label}
          className={styles.expression}
          key={expression.label}
        >
          {shouldLoad ? (
            // biome-ignore lint/performance/noImgElement: the route returns a fixed roster thumbnail
            <img
              src={`/api/codec-pack/${packId}/${expression.source}?v=${packVersion}&variant=roster-v1`}
              alt={`${packId} character with ${expression.label} expression`}
              width={256}
              height={384}
              loading="eager"
              fetchPriority={initiallyLoad && !persistent ? "high" : "low"}
            />
          ) : (
            <span className={styles.expressionPlaceholder} aria-hidden />
          )}
          <figcaption>{expression.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}
