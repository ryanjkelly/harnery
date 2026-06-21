// Width-fill + horizontal-overflow check primitives for `harn browse`.
//
// Companions to visibility.ts: visibility catches "the element is hidden /
// occluded"; layout catches "the element is the wrong size or in the wrong
// place." The bug this exists to catch: a `<table>` at 85% viewport fill
// (correct CSS-visibility, no occlusion, where every existing per-element check
// passes), or a `<nav>` overflowing the viewport's right edge by 92px and
// triggering horizontal scroll on mobile.
//
// Two independent checks, surfaced together because they're often co-symptoms
// of the same root cause (stacked padding, missing flex-wrap, fixed widths
// that don't shrink on narrow viewports):
//
//   --check-width <selector>      assert one element's width is >= N% of viewport
//   --check-overflow              assert document has no horizontal overflow

export interface WidthResult {
  selector: string;
  found: boolean;
  rect: { x: number; y: number; width: number; height: number };
  parentTag: string;
  parentWidth: number;
  viewportWidth: number;
  /** `rect.width / viewportWidth`, rounded to 3 decimals. */
  viewportFill: number;
  /** `rect.width / parentWidth`, rounded to 3 decimals. 0 when no parent. */
  parentFill: number;
}

/** One element protruding past the viewport. */
export interface OverflowElement {
  tagName: string;
  className: string;
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Pixels this element's own width exceeds the viewport. 0 if it fits. */
  widthOverflowPx: number;
  /** Pixels this element's right edge extends past the viewport's right. */
  rightOverflowPx: number;
}

export interface OverflowResult {
  viewport: { width: number; height: number };
  documentScrollWidth: number;
  hasHorizontalOverflow: boolean;
  /** documentScrollWidth - viewport.width. Negative/zero means no overflow. */
  overflowPx: number;
  /** Top N elements whose own width exceeds viewport, ranked desc. */
  widerThanViewport: OverflowElement[];
  /** Top N elements whose right edge protrudes past viewport (but own width fits). */
  rightOverflow: OverflowElement[];
}

/**
 * Build the JS function passed to `page.evaluate`. Returns a function
 * reference (not a string) so Playwright serializes args properly.
 */
export function buildWidthCheck(): (args: { selectors: string[] }) => WidthResult[] {
  return ({ selectors }) => {
    const vw = window.innerWidth;

    function checkOne(selector: string): WidthResult {
      const empty: WidthResult = {
        selector,
        found: false,
        rect: { x: 0, y: 0, width: 0, height: 0 },
        parentTag: "",
        parentWidth: 0,
        viewportWidth: vw,
        viewportFill: 0,
        parentFill: 0,
      };
      const el = document.querySelector(selector);
      if (!(el instanceof Element)) return empty;

      const rect = el.getBoundingClientRect();
      const parent = el.parentElement;
      const parentRect = parent ? parent.getBoundingClientRect() : null;

      const viewportFill = vw > 0 ? rect.width / vw : 0;
      const parentFill = parentRect && parentRect.width > 0 ? rect.width / parentRect.width : 0;

      return {
        selector,
        found: true,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        parentTag: parent ? parent.tagName.toLowerCase() : "",
        parentWidth: parentRect ? Math.round(parentRect.width) : 0,
        viewportWidth: vw,
        viewportFill: Math.round(viewportFill * 1000) / 1000,
        parentFill: Math.round(parentFill * 1000) / 1000,
      };
    }

    return selectors.map(checkOne);
  };
}

/**
 * Build the JS function for overflow detection. Sweeps every element for
 * widthOverflow (own width > viewport) and rightOverflow (right-edge past
 * viewport). Caps each list at `sampleLimit` so a degenerate document with
 * thousands of overflowing elements doesn't blow up the JSON envelope.
 */
export function buildOverflowCheck(): (args: { sampleLimit: number }) => OverflowResult {
  return ({ sampleLimit }) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docScrollW = document.documentElement.scrollWidth;
    const tolerance = 1;

    const widerThanViewport: OverflowElement[] = [];
    const rightOverflow: OverflowElement[] = [];

    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;

      const widthOverflow = r.width - vw;
      const rightOverflowPx = r.right - vw;

      const cls =
        typeof el.className === "string"
          ? el.className.slice(0, 200)
          : (el.getAttribute("class") ?? "");
      const rect = {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      };

      if (widthOverflow > tolerance) {
        widerThanViewport.push({
          tagName: el.tagName.toLowerCase(),
          className: cls,
          id: el.id || "",
          rect,
          widthOverflowPx: Math.round(widthOverflow),
          rightOverflowPx: Math.max(0, Math.round(rightOverflowPx)),
        });
      } else if (rightOverflowPx > tolerance) {
        rightOverflow.push({
          tagName: el.tagName.toLowerCase(),
          className: cls,
          id: el.id || "",
          rect,
          widthOverflowPx: 0,
          rightOverflowPx: Math.round(rightOverflowPx),
        });
      }
    }

    widerThanViewport.sort((a, b) => b.widthOverflowPx - a.widthOverflowPx);
    rightOverflow.sort((a, b) => b.rightOverflowPx - a.rightOverflowPx);

    return {
      viewport: { width: vw, height: vh },
      documentScrollWidth: docScrollW,
      hasHorizontalOverflow: docScrollW > vw + tolerance,
      overflowPx: docScrollW - vw,
      widerThanViewport: widerThanViewport.slice(0, sampleLimit),
      rightOverflow: rightOverflow.slice(0, sampleLimit),
    };
  };
}

/**
 * Annotate width-check + overflow results onto the live page so the captured
 * screenshot carries the diagnostic overlay. Separate root from
 * visibility.ts's annotations so both can coexist on the same screenshot.
 *
 * Width targets: green if `viewportFill >= widthThreshold`, red otherwise.
 * Overflow: dashed amber line at the viewport's right edge + amber boxes
 * around each protruding element.
 */
export function buildLayoutAnnotateScript(): (args: {
  widths: WidthResult[];
  overflow: OverflowResult | null;
  widthThreshold: number;
}) => void {
  return ({ widths, overflow, widthThreshold }) => {
    const ROOT_ID = "__bp-check-layout-annotations__";
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText = "position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;";
    document.body.appendChild(root);

    const drawBox = (
      rect: { x: number; y: number; width: number; height: number },
      color: string,
      label: string,
      labelPos: "top" | "bottom" = "top",
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
        ${labelPos === "top" ? "top: -18px;" : "bottom: -18px;"}
        background: ${color};
        color: #fff;
        font: 12px/1.4 -apple-system, system-ui, sans-serif;
        padding: 1px 6px;
        border-radius: 3px;
        white-space: nowrap;
        pointer-events: none;
      `;
      box.appendChild(tag);
      root.appendChild(box);
    };

    for (const w of widths) {
      if (!w.found) continue;
      const passing = w.viewportFill >= widthThreshold;
      drawBox(
        w.rect,
        passing ? "#10b981" : "#ef4444",
        `${w.selector}  vfill=${(w.viewportFill * 100).toFixed(0)}%`,
      );
    }

    if (overflow) {
      const edgeLine = document.createElement("div");
      edgeLine.style.cssText = `
        position: absolute;
        left: ${overflow.viewport.width}px;
        top: 0;
        width: 0;
        height: 100vh;
        border-left: 2px dashed #f59e0b;
        pointer-events: none;
      `;
      root.appendChild(edgeLine);

      const edgeLabel = document.createElement("div");
      edgeLabel.textContent = `viewport edge (${overflow.viewport.width}px)`;
      edgeLabel.style.cssText = `
        position: absolute;
        left: ${overflow.viewport.width + 4}px;
        top: 4px;
        background: #f59e0b;
        color: #fff;
        font: 12px/1.4 -apple-system, system-ui, sans-serif;
        padding: 1px 6px;
        border-radius: 3px;
        white-space: nowrap;
        pointer-events: none;
      `;
      root.appendChild(edgeLabel);

      for (const o of [...overflow.widerThanViewport, ...overflow.rightOverflow]) {
        const label =
          o.widthOverflowPx > 0
            ? `${o.tagName}  +${o.widthOverflowPx}px wider than viewport`
            : `${o.tagName}  +${o.rightOverflowPx}px past right edge`;
        drawBox(o.rect, "#f59e0b", label, "bottom");
      }
    }
  };
}

export function buildClearLayoutAnnotationsScript(): () => void {
  return () => {
    document.getElementById("__bp-check-layout-annotations__")?.remove();
  };
}
