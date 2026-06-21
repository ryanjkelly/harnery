// Visibility / occlusion check primitive for `harn browse --check-visible`.
//
// The bug this exists to catch: a sticky-bottom composer strip painting over
// a `position: absolute; bottom: 208px` scroll-to-bottom pill, where every
// other check (element exists, has dimensions, is "in viewport") passes
// because the pill's bounding rect IS technically inside the visible area;
// it's just rendered behind another element.
//
// Mechanism: get the target's getBoundingClientRect, sample a grid of points
// inside it, call document.elementFromPoint(x, y) per sample, and count
// samples where the returned element is the target (or one of its
// descendants). visibleRatio = visibleSamples / validSamples. Report the
// dominant occluder for diagnostics.

export interface VisibilitySample {
  x: number;
  y: number;
  status: "visible" | "occluded" | "outside-viewport" | "no-element";
  occluderTag?: string;
  occluderClass?: string;
}

export type CssHiddenReason =
  | "display-none"
  | "visibility-hidden"
  | "opacity-zero"
  | "content-visibility-hidden"
  | "pointer-events-none-with-opacity-zero"
  | "unknown";

export interface VisibilityResult {
  selector: string;
  found: boolean;
  inViewport: boolean;
  partiallyInViewport: boolean;
  rect: { x: number; y: number; width: number; height: number };
  /**
   * Pure CSS-level visibility via `Element.checkVisibility()` with opacity +
   * visibility + content-visibility checks enabled, plus an ancestor walk
   * to identify which property is hiding the element. Catches the class of
   * bug where an element is in layout (has rect, is in viewport) but is
   * painted with opacity:0 / visibility:hidden / display:none: invisible
   * to the user but invisible to occlusion-only checks too.
   */
  cssVisible: boolean;
  /** Which property+element actually hides it. Null when cssVisible=true. */
  hiddenBy: {
    reason: CssHiddenReason;
    ancestorTag: string;
    ancestorClass: string;
    ancestorId: string;
    propertyValue: string;
  } | null;
  /** Fraction of in-viewport samples where the target (or a descendant) was the topmost element. 0 = fully occluded, 1 = fully visible. Always 0 when cssVisible=false (sampling skipped). */
  visibleRatio: number;
  samples: VisibilitySample[];
  occludedBy: {
    tagName: string;
    className: string;
    id: string;
    outerHTML: string;
    computedStyles: { position?: string; zIndex?: string; backgroundColor?: string };
    rect: { x: number; y: number; width: number; height: number };
  } | null;
  elementOuterHTML: string;
}

export interface CheckVisibilityOptions {
  /** Grid size: sampleGrid × sampleGrid points across the target's rect. Default 3 (9 samples). */
  sampleGrid?: number;
}

/**
 * Build the JS function passed to Playwright's `page.evaluate`. Returns
 * a function reference (not a string) so Playwright serializes args
 * properly. Caller invokes via `page.evaluate(fn, { selectors, sampleGrid })`.
 */
export function buildVisibilityCheck(): (args: {
  selectors: string[];
  sampleGrid: number;
}) => VisibilityResult[] {
  return ({ selectors, sampleGrid }) => {
    function findHiddenAncestor(start: Element): VisibilityResult["hiddenBy"] {
      let cur: Element | null = start;
      while (cur) {
        const cs = window.getComputedStyle(cur);
        const tag = cur.tagName.toLowerCase();
        const cls =
          typeof cur.className === "string" ? cur.className : (cur.getAttribute("class") ?? "");
        const id = cur.id ?? "";
        if (cs.display === "none") {
          return {
            reason: "display-none",
            ancestorTag: tag,
            ancestorClass: cls,
            ancestorId: id,
            propertyValue: "display: none",
          };
        }
        if (cs.visibility === "hidden" || cs.visibility === "collapse") {
          return {
            reason: "visibility-hidden",
            ancestorTag: tag,
            ancestorClass: cls,
            ancestorId: id,
            propertyValue: `visibility: ${cs.visibility}`,
          };
        }
        const op = Number.parseFloat(cs.opacity || "1");
        if (op === 0) {
          // Distinguish opacity:0 alone from opacity:0 + pointer-events:none.
          // The latter is the "hidden-but-keeps-layout" pattern that
          // also makes elementFromPoint skip the element and surface the
          // wrong "occluded" answer.
          const pe = cs.pointerEvents;
          return {
            reason: pe === "none" ? "pointer-events-none-with-opacity-zero" : "opacity-zero",
            ancestorTag: tag,
            ancestorClass: cls,
            ancestorId: id,
            propertyValue: `opacity: 0${pe === "none" ? "; pointer-events: none" : ""}`,
          };
        }
        // contentVisibility is read via the style declaration since it's
        // a property name with hyphens in the standard property list.
        const cv = (cs as CSSStyleDeclaration & { contentVisibility?: string }).contentVisibility;
        if (cv === "hidden") {
          return {
            reason: "content-visibility-hidden",
            ancestorTag: tag,
            ancestorClass: cls,
            ancestorId: id,
            propertyValue: "content-visibility: hidden",
          };
        }
        cur = cur.parentElement;
      }
      return null;
    }

    function checkOne(selector: string): VisibilityResult {
      const empty: VisibilityResult = {
        selector,
        found: false,
        inViewport: false,
        partiallyInViewport: false,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        cssVisible: false,
        hiddenBy: null,
        visibleRatio: 0,
        samples: [],
        occludedBy: null,
        elementOuterHTML: "",
      };
      const el = document.querySelector(selector);
      if (!(el instanceof Element)) return empty;

      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const inViewport = rect.top >= 0 && rect.bottom <= vh && rect.left >= 0 && rect.right <= vw;
      const partiallyInViewport = !(
        rect.bottom <= 0 ||
        rect.top >= vh ||
        rect.right <= 0 ||
        rect.left >= vw
      );

      // CSS-level visibility check FIRST. Element.checkVisibility() is the
      // standard primitive (Chromium 105+, Safari 17.4+, Firefox 125+); we
      // also walk the ancestor chain to identify which property is hiding
      // it. If the element is CSS-hidden, occlusion sampling is irrelevant,
      // so short-circuit with visibleRatio=0 and skip the elementFromPoint
      // calls (which would otherwise surface misleading "occluded by ..."
      // answers when pointer-events:none is in play).
      const checkVis = (el as Element & { checkVisibility?: (opts: object) => boolean })
        .checkVisibility;
      const cssVisible =
        typeof checkVis === "function"
          ? checkVis.call(el, {
              contentVisibilityAuto: true,
              opacityProperty: true,
              visibilityProperty: true,
            })
          : (() => {
              // Fallback for browsers without Element.checkVisibility:
              // detect via the same ancestor walk we use to identify
              // hiddenBy. cssVisible = (no ancestor in the chain hides it).
              return findHiddenAncestor(el) === null;
            })();
      const hiddenBy = cssVisible ? null : findHiddenAncestor(el);

      if (!cssVisible) {
        return {
          selector,
          found: true,
          inViewport,
          partiallyInViewport,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          cssVisible: false,
          hiddenBy,
          visibleRatio: 0,
          samples: [],
          occludedBy: null,
          elementOuterHTML: el.outerHTML.slice(0, 500),
        };
      }

      const samples: VisibilitySample[] = [];
      let visibleCount = 0;
      let validCount = 0;
      const occluderCounts: Record<string, { count: number; firstX: number; firstY: number }> = {};

      for (let i = 1; i <= sampleGrid; i++) {
        for (let j = 1; j <= sampleGrid; j++) {
          const x = rect.left + (rect.width * i) / (sampleGrid + 1);
          const y = rect.top + (rect.height * j) / (sampleGrid + 1);

          if (x < 0 || x >= vw || y < 0 || y >= vh) {
            samples.push({ x: Math.round(x), y: Math.round(y), status: "outside-viewport" });
            continue;
          }
          validCount++;

          const topEl = document.elementFromPoint(x, y);
          if (!topEl) {
            samples.push({ x: Math.round(x), y: Math.round(y), status: "no-element" });
            continue;
          }

          // Visible if topmost element is the target itself OR one of its
          // descendants (e.g. the pill button contains an SVG icon, so sampling
          // the icon area still counts as the pill being visible).
          const visible = topEl === el || el.contains(topEl);
          if (visible) {
            samples.push({ x: Math.round(x), y: Math.round(y), status: "visible" });
            visibleCount++;
          } else {
            const tag = topEl.tagName.toLowerCase();
            const cls =
              typeof topEl.className === "string"
                ? topEl.className
                : (topEl.getAttribute("class") ?? "");
            const key = `${tag}|${cls}`;
            const existing = occluderCounts[key];
            if (existing) {
              existing.count++;
            } else {
              occluderCounts[key] = {
                count: 1,
                firstX: x,
                firstY: y,
              };
            }
            samples.push({
              x: Math.round(x),
              y: Math.round(y),
              status: "occluded",
              occluderTag: tag,
              occluderClass: cls,
            });
          }
        }
      }

      let occludedBy: VisibilityResult["occludedBy"] = null;
      const ranked = Object.entries(occluderCounts).sort((a, b) => b[1].count - a[1].count);
      if (ranked.length > 0) {
        const top = ranked[0]!;
        const [, info] = top;
        const occluderEl = document.elementFromPoint(info.firstX, info.firstY);
        if (occluderEl instanceof Element) {
          const cs = window.getComputedStyle(occluderEl);
          const orect = occluderEl.getBoundingClientRect();
          occludedBy = {
            tagName: occluderEl.tagName.toLowerCase(),
            className:
              typeof occluderEl.className === "string"
                ? occluderEl.className
                : (occluderEl.getAttribute("class") ?? ""),
            id: occluderEl.id ?? "",
            outerHTML: occluderEl.outerHTML.slice(0, 500),
            computedStyles: {
              position: cs.position,
              zIndex: cs.zIndex,
              backgroundColor: cs.backgroundColor,
            },
            rect: {
              x: Math.round(orect.x),
              y: Math.round(orect.y),
              width: Math.round(orect.width),
              height: Math.round(orect.height),
            },
          };
        }
      }

      return {
        selector,
        found: true,
        inViewport,
        partiallyInViewport,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        cssVisible: true,
        hiddenBy: null,
        visibleRatio: validCount > 0 ? visibleCount / validCount : 0,
        samples,
        occludedBy,
        elementOuterHTML: el.outerHTML.slice(0, 500),
      };
    }

    return selectors.map(checkOne);
  };
}

/**
 * Build a script that injects overlay rectangles for each visibility result.
 * Green border = target, red border = dominant occluder. Caller injects via
 * `page.evaluate`, takes the screenshot, then clears via
 * `buildClearAnnotationsScript`. Boxes are absolutely positioned at the
 * target/occluder's `getBoundingClientRect()` location, so they survive
 * scroll changes between sample-time and screenshot-time only if nothing
 * has scrolled. The recommended flow is sample → annotate → screenshot →
 * clear without intervening scrolls.
 */
export function buildAnnotateScript(): (args: { results: VisibilityResult[] }) => void {
  return ({ results }) => {
    const ROOT_ID = "__bp-check-visible-annotations__";
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText = "position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;";
    document.body.appendChild(root);

    const drawBox = (
      rect: { x: number; y: number; width: number; height: number },
      color: string,
      label: string,
    ): void => {
      const box = document.createElement("div");
      box.style.cssText = `
        position: absolute;
        left: ${rect.x}px;
        top: ${rect.y}px;
        width: ${rect.width}px;
        height: ${rect.height}px;
        border: 2px solid ${color};
        box-sizing: border-box;
        background: ${color}1a;
        pointer-events: none;
      `;
      const tag = document.createElement("div");
      tag.textContent = label;
      tag.style.cssText = `
        position: absolute;
        left: 0;
        top: -18px;
        background: ${color};
        color: #fff;
        font: 12px/1.4 -apple-system, system-ui, sans-serif;
        padding: 1px 6px;
        border-radius: 3px 3px 3px 0;
        white-space: nowrap;
        pointer-events: none;
      `;
      box.appendChild(tag);
      root.appendChild(box);
    };

    for (const r of results) {
      if (!r.found) continue;
      // Color the target by failure mode:
      //   green:   cssVisible + visibleRatio>=0.9 (actually visible)
      //   red:     cssVisible + visibleRatio<0.9 (occluded by sibling)
      //   magenta: !cssVisible (CSS-hidden via opacity/display/visibility/...)
      let color: string;
      let label: string;
      if (!r.cssVisible) {
        color = "#a855f7"; // tailwind purple-500
        const hb = r.hiddenBy;
        label = hb
          ? `${r.selector}  HIDDEN [${hb.reason}] via ${hb.ancestorTag}${hb.ancestorId ? `#${hb.ancestorId}` : ""}`
          : `${r.selector}  HIDDEN`;
      } else if (r.visibleRatio >= 0.9) {
        color = "#10b981"; // tailwind emerald-500
        label = `${r.selector}  ratio=${(r.visibleRatio * 100).toFixed(0)}%`;
      } else {
        color = "#ef4444"; // tailwind red-500
        label = `${r.selector}  ratio=${(r.visibleRatio * 100).toFixed(0)}%`;
      }
      drawBox(r.rect, color, label);
      if (r.cssVisible && r.occludedBy && r.visibleRatio < 0.9) {
        drawBox(
          r.occludedBy.rect,
          "#f59e0b", // amber-500
          `occluder: ${r.occludedBy.tagName}${r.occludedBy.id ? `#${r.occludedBy.id}` : ""}`,
        );
      }
    }
  };
}

export function buildClearAnnotationsScript(): () => void {
  return () => {
    document.getElementById("__bp-check-visible-annotations__")?.remove();
  };
}
