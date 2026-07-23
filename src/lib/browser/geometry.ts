export type LayoutOutcome = "pass" | "fail" | "unknown";
export type LayoutAxis = "auto" | "x" | "y";

export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface LayoutElementMeasurement {
  index: number;
  tag: string;
  label: string;
  snippet: string;
  source: "text" | "svg" | "box";
  rect: LayoutRect;
}

export interface LayoutExclusion {
  index: number;
  tag: string;
  reason: "hidden" | "zero-area" | "out-of-flow" | "limit";
}

export interface AlignChild extends LayoutElementMeasurement {
  mid: number;
  deltaPx: number;
  fail: boolean;
}

export interface AlignCluster {
  referenceMid: number;
  referenceSource: "text-median" | "all-median";
  children: AlignChild[];
}

export interface AlignResult {
  rule: "align";
  selector: string;
  found: boolean;
  outcome: LayoutOutcome;
  axis: "x" | "y";
  tolerancePx: number;
  clusters: AlignCluster[];
  excluded: LayoutExclusion[];
}

export interface GapPair {
  before: LayoutElementMeasurement;
  after: LayoutElementMeasurement;
  observedGapPx: number;
  referenceGapPx: number | null;
  deltaPx: number | null;
  fail: boolean;
}

export interface GapCluster {
  referenceGapPx: number | null;
  referenceSource: "explicit" | "median" | "unavailable";
  outcome: LayoutOutcome;
  pairs: GapPair[];
}

export interface GapResult {
  rule: "gap";
  selector: string;
  found: boolean;
  outcome: LayoutOutcome;
  axis: "x" | "y";
  tolerancePx: number;
  expectedGapPx: number | null;
  clusters: GapCluster[];
  excluded: LayoutExclusion[];
}

export interface ClipIssue {
  element: LayoutElementMeasurement;
  clippedBy: string;
  overrun: { top: number; right: number; bottom: number; left: number };
  maxOverrunPx: number;
}

export interface ClipResult {
  rule: "clip";
  selector: string;
  found: boolean;
  outcome: LayoutOutcome;
  tolerancePx: number;
  issues: ClipIssue[];
  unsupported: string[];
  excluded: LayoutExclusion[];
  truncated: boolean;
}

export interface OverlapIssue {
  first: LayoutElementMeasurement;
  second: LayoutElementMeasurement;
  intersection: LayoutRect;
  areaPx: number;
}

export interface OverlapResult {
  rule: "overlap";
  selector: string;
  found: boolean;
  outcome: LayoutOutcome;
  tolerancePx: number;
  issues: OverlapIssue[];
  excluded: LayoutExclusion[];
  truncated: boolean;
}

export interface LayoutLintRequest {
  align: Array<{ selector: string; axis: LayoutAxis; tolerancePx: number }>;
  gap: Array<{
    selector: string;
    axis: LayoutAxis;
    tolerancePx: number;
    expectedGapPx: number | null;
  }>;
  clip: Array<{ selector: string; tolerancePx: number }>;
  overlap: Array<{ selector: string; tolerancePx: number }>;
}

export interface LayoutLintResult {
  align: AlignResult[];
  gap: GapResult[];
  clip: ClipResult[];
  overlap: OverlapResult[];
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

export function intersectRects(a: LayoutRect, b: LayoutRect): LayoutRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    top,
    right,
    bottom,
    left,
  };
}

/**
 * One self-contained page evaluator for the rendered-geometry rule family.
 * Helpers are nested because Playwright serializes the returned function and
 * cannot follow module-level closures into the browser context.
 */
export function buildLayoutLintCheck(): (request: LayoutLintRequest) => LayoutLintResult {
  return (request) => {
    const CHILD_LIMIT = 250;
    const ISSUE_LIMIT = 100;

    const rectOf = (rect: DOMRect): LayoutRect => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    });

    const medianOf = (values: number[]): number => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
      return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
    };

    const labelOf = (element: Element): string => {
      const tag = element.tagName.toLowerCase();
      if (element.id) return `${tag}#${element.id}`;
      const cls =
        typeof element.className === "string"
          ? element.className.trim()
          : (element.getAttribute("class") ?? "").trim();
      return cls ? `${tag}.${cls.split(/\s+/).slice(0, 2).join(".")}` : tag;
    };

    const isHidden = (element: Element): boolean => {
      let current: Element | null = element;
      while (current) {
        const style = getComputedStyle(current);
        const contentVisibility = (style as CSSStyleDeclaration & { contentVisibility?: string })
          .contentVisibility;
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity || "1") === 0 ||
          contentVisibility === "hidden"
        ) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };

    const firstTextRect = (element: Element): DOMRect | null => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const value = node.nodeValue ?? "";
        const match = /\S+/.exec(value);
        if (!match || match.index === undefined) continue;
        const parent = node.parentElement;
        if (parent && ["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return rect;
      }
      return null;
    };

    const measure = (
      element: Element,
      index: number,
      visual: boolean,
    ): LayoutElementMeasurement => {
      const box = element.getBoundingClientRect();
      let source: LayoutElementMeasurement["source"] = "box";
      let chosen = box;
      if (visual) {
        const textRect = firstTextRect(element);
        const svg = element instanceof SVGElement ? element : element.querySelector("svg");
        const svgRect = svg?.getBoundingClientRect();
        if (textRect) {
          chosen = textRect;
          source = "text";
        } else if (svgRect && svgRect.width > 0 && svgRect.height > 0) {
          chosen = svgRect;
          source = "svg";
        }
      }
      return {
        index,
        tag: element.tagName.toLowerCase(),
        label: labelOf(element),
        snippet: element.outerHTML.replace(/\s+/g, " ").slice(0, 160),
        source,
        rect: rectOf(chosen),
      };
    };

    const collectChildren = (
      container: Element,
      visual: boolean,
    ): { measured: LayoutElementMeasurement[]; excluded: LayoutExclusion[] } => {
      const measured: LayoutElementMeasurement[] = [];
      const excluded: LayoutExclusion[] = [];
      const children = [...container.children];
      for (let index = 0; index < children.length; index++) {
        const element = children[index];
        if (!element) continue;
        if (index >= CHILD_LIMIT) {
          excluded.push({ index, tag: element.tagName.toLowerCase(), reason: "limit" });
          continue;
        }
        if (isHidden(element)) {
          excluded.push({ index, tag: element.tagName.toLowerCase(), reason: "hidden" });
          continue;
        }
        const style = getComputedStyle(element);
        if (style.position === "absolute" || style.position === "fixed") {
          excluded.push({ index, tag: element.tagName.toLowerCase(), reason: "out-of-flow" });
          continue;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          excluded.push({ index, tag: element.tagName.toLowerCase(), reason: "zero-area" });
          continue;
        }
        measured.push(measure(element, index, visual));
      }
      return { measured, excluded };
    };

    const resolveAxis = (container: Element, requested: LayoutAxis): "x" | "y" => {
      if (requested !== "auto") return requested;
      const style = getComputedStyle(container);
      if (style.display.includes("flex") && style.flexDirection.startsWith("column")) return "x";
      return "y";
    };

    const clustersOf = (
      children: LayoutElementMeasurement[],
      axis: "x" | "y",
    ): LayoutElementMeasurement[][] => {
      const crossStart = (item: LayoutElementMeasurement) =>
        axis === "y" ? item.rect.top : item.rect.left;
      const crossEnd = (item: LayoutElementMeasurement) =>
        axis === "y" ? item.rect.bottom : item.rect.right;
      const ordered = [...children].sort((a, b) => crossStart(a) - crossStart(b));
      const clusters: Array<{
        start: number;
        end: number;
        children: LayoutElementMeasurement[];
      }> = [];
      for (const child of ordered) {
        const start = crossStart(child);
        const end = crossEnd(child);
        let cluster = clusters.find((candidate) => start < candidate.end && end > candidate.start);
        if (!cluster) {
          cluster = { start, end, children: [] };
          clusters.push(cluster);
        }
        cluster.start = Math.min(cluster.start, start);
        cluster.end = Math.max(cluster.end, end);
        cluster.children.push(child);
      }
      const mainStart = (item: LayoutElementMeasurement) =>
        axis === "y" ? item.rect.left : item.rect.top;
      return clusters.map((cluster) =>
        cluster.children.sort((a, b) => mainStart(a) - mainStart(b)),
      );
    };

    const emptyAlign = (selector: string, axis: "x" | "y", tolerancePx: number): AlignResult => ({
      rule: "align",
      selector,
      found: false,
      outcome: "fail",
      axis,
      tolerancePx,
      clusters: [],
      excluded: [],
    });

    const align = request.align.map(({ selector, axis: requested, tolerancePx }) => {
      const container = document.querySelector(selector);
      const fallbackAxis = requested === "x" ? "x" : "y";
      if (!(container instanceof Element)) return emptyAlign(selector, fallbackAxis, tolerancePx);
      const axis = resolveAxis(container, requested);
      const { measured, excluded } = collectChildren(container, true);
      const clusters: AlignCluster[] = clustersOf(measured, axis).map((children) => {
        const text = children.filter((child) => child.source === "text");
        const population = text.length > 0 ? text : children;
        const centerOf = (child: LayoutElementMeasurement) =>
          axis === "y"
            ? child.rect.top + child.rect.height / 2
            : child.rect.left + child.rect.width / 2;
        const referenceMid = medianOf(population.map(centerOf));
        return {
          referenceMid,
          referenceSource: text.length > 0 ? "text-median" : "all-median",
          children: children.map((child) => {
            const mid = centerOf(child);
            const deltaPx = mid - referenceMid;
            return { ...child, mid, deltaPx, fail: Math.abs(deltaPx) > tolerancePx };
          }),
        };
      });
      const failed = clusters.some((cluster) => cluster.children.some((child) => child.fail));
      return {
        rule: "align" as const,
        selector,
        found: true,
        outcome: failed ? ("fail" as const) : ("pass" as const),
        axis,
        tolerancePx,
        clusters,
        excluded,
      };
    });

    const gap = request.gap.map(
      ({ selector, axis: requested, tolerancePx, expectedGapPx }): GapResult => {
        const container = document.querySelector(selector);
        const fallbackAxis = requested === "x" ? "x" : "y";
        if (!(container instanceof Element)) {
          return {
            rule: "gap" as const,
            selector,
            found: false,
            outcome: "fail" as const,
            axis: fallbackAxis,
            tolerancePx,
            expectedGapPx,
            clusters: [],
            excluded: [],
          };
        }
        const axis = resolveAxis(container, requested);
        const { measured, excluded } = collectChildren(container, false);
        const clusters: GapCluster[] = clustersOf(measured, axis).map((children) => {
          const observed = children.slice(1).map((child, index) => {
            const previous = children[index];
            if (!previous) return 0;
            return axis === "y"
              ? child.rect.left - previous.rect.right
              : child.rect.top - previous.rect.bottom;
          });
          const canInfer = children.length >= 3;
          const reference = expectedGapPx ?? (canInfer ? medianOf(observed) : null);
          const pairs = observed.map((observedGapPx, index): GapPair => {
            const before = children[index]!;
            const after = children[index + 1]!;
            const deltaPx = reference === null ? null : observedGapPx - reference;
            return {
              before,
              after,
              observedGapPx,
              referenceGapPx: reference,
              deltaPx,
              fail: deltaPx !== null && Math.abs(deltaPx) > tolerancePx,
            };
          });
          const outcome: LayoutOutcome =
            reference === null ? "unknown" : pairs.some((pair) => pair.fail) ? "fail" : "pass";
          return {
            referenceGapPx: reference,
            referenceSource:
              expectedGapPx !== null ? "explicit" : canInfer ? "median" : "unavailable",
            outcome,
            pairs,
          };
        });
        const outcome: LayoutOutcome = clusters.some((cluster) => cluster.outcome === "fail")
          ? "fail"
          : clusters.some((cluster) => cluster.outcome === "unknown")
            ? "unknown"
            : "pass";
        return {
          rule: "gap" as const,
          selector,
          found: true,
          outcome,
          axis,
          tolerancePx,
          expectedGapPx,
          clusters,
          excluded,
        };
      },
    );

    const clippingStyle = (element: Element): { x: boolean; y: boolean } => {
      const style = getComputedStyle(element);
      const clips = new Set(["hidden", "clip", "auto", "scroll"]);
      return { x: clips.has(style.overflowX), y: clips.has(style.overflowY) };
    };

    const paddingRect = (element: Element): LayoutRect => {
      const rect = element.getBoundingClientRect();
      const html = element as HTMLElement;
      const left = rect.left + html.clientLeft;
      const top = rect.top + html.clientTop;
      const width = html.clientWidth;
      const height = html.clientHeight;
      return {
        x: left,
        y: top,
        width,
        height,
        top,
        right: left + width,
        bottom: top + height,
        left,
      };
    };

    const clip = request.clip.map(({ selector, tolerancePx }): ClipResult => {
      const container = document.querySelector(selector);
      if (!(container instanceof Element)) {
        return {
          rule: "clip" as const,
          selector,
          found: false,
          outcome: "fail" as const,
          tolerancePx,
          issues: [],
          unsupported: [],
          excluded: [],
          truncated: false,
        };
      }
      const unsupported = new Set<string>();
      const excluded: LayoutExclusion[] = [];
      const issues: ClipIssue[] = [];
      const descendants = [...container.querySelectorAll("*")];
      let truncated = descendants.length > CHILD_LIMIT;
      descendants.slice(0, CHILD_LIMIT).forEach((element, index) => {
        if (isHidden(element)) {
          excluded.push({ index, tag: element.tagName.toLowerCase(), reason: "hidden" });
          return;
        }
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) {
          excluded.push({ index, tag: element.tagName.toLowerCase(), reason: "zero-area" });
          return;
        }
        let allowed = paddingRect(container);
        let clippedBy = labelOf(container);
        let current: Element | null = element.parentElement;
        while (current && container.contains(current)) {
          const style = getComputedStyle(current);
          if (style.clipPath && style.clipPath !== "none")
            unsupported.add(`${labelOf(current)}:clip-path`);
          if (style.borderRadius && !/^0(?:px)?(?: 0(?:px)?){0,3}$/.test(style.borderRadius)) {
            unsupported.add(`${labelOf(current)}:border-radius`);
          }
          if (style.transform && style.transform !== "none")
            unsupported.add(`${labelOf(current)}:transform`);
          const clips = current === container ? { x: true, y: true } : clippingStyle(current);
          if (clips.x || clips.y) {
            const candidate = paddingRect(current);
            allowed = {
              x: clips.x ? Math.max(allowed.left, candidate.left) : allowed.left,
              y: clips.y ? Math.max(allowed.top, candidate.top) : allowed.top,
              left: clips.x ? Math.max(allowed.left, candidate.left) : allowed.left,
              top: clips.y ? Math.max(allowed.top, candidate.top) : allowed.top,
              right: clips.x ? Math.min(allowed.right, candidate.right) : allowed.right,
              bottom: clips.y ? Math.min(allowed.bottom, candidate.bottom) : allowed.bottom,
              width: 0,
              height: 0,
            };
            allowed.width = Math.max(0, allowed.right - allowed.left);
            allowed.height = Math.max(0, allowed.bottom - allowed.top);
            clippedBy = labelOf(current);
          }
          if (current === container) break;
          current = current.parentElement;
        }
        const overrun = {
          top: Math.max(0, allowed.top - rect.top),
          right: Math.max(0, rect.right - allowed.right),
          bottom: Math.max(0, rect.bottom - allowed.bottom),
          left: Math.max(0, allowed.left - rect.left),
        };
        const maxOverrunPx = Math.max(overrun.top, overrun.right, overrun.bottom, overrun.left);
        if (maxOverrunPx > tolerancePx && issues.length < ISSUE_LIMIT) {
          issues.push({
            element: measure(element, index, false),
            clippedBy,
            overrun,
            maxOverrunPx,
          });
        }
      });
      if (issues.length >= ISSUE_LIMIT) truncated = true;
      const outcome: LayoutOutcome =
        issues.length > 0 ? "fail" : unsupported.size > 0 ? "unknown" : "pass";
      return {
        rule: "clip" as const,
        selector,
        found: true,
        outcome,
        tolerancePx,
        issues,
        unsupported: [...unsupported].slice(0, 50),
        excluded,
        truncated,
      };
    });

    const overlap = request.overlap.map(({ selector, tolerancePx }): OverlapResult => {
      const container = document.querySelector(selector);
      if (!(container instanceof Element)) {
        return {
          rule: "overlap" as const,
          selector,
          found: false,
          outcome: "fail" as const,
          tolerancePx,
          issues: [],
          excluded: [],
          truncated: false,
        };
      }
      const { measured, excluded } = collectChildren(container, false);
      const issues: OverlapIssue[] = [];
      let truncated = false;
      for (let firstIndex = 0; firstIndex < measured.length; firstIndex++) {
        for (let secondIndex = firstIndex + 1; secondIndex < measured.length; secondIndex++) {
          const first = measured[firstIndex];
          const second = measured[secondIndex];
          if (!first || !second) continue;
          const left = Math.max(first.rect.left, second.rect.left);
          const top = Math.max(first.rect.top, second.rect.top);
          const right = Math.min(first.rect.right, second.rect.right);
          const bottom = Math.min(first.rect.bottom, second.rect.bottom);
          const width = right - left;
          const height = bottom - top;
          if (width <= tolerancePx || height <= tolerancePx) continue;
          issues.push({
            first,
            second,
            intersection: { x: left, y: top, width, height, top, right, bottom, left },
            areaPx: width * height,
          });
          if (issues.length >= ISSUE_LIMIT) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      return {
        rule: "overlap" as const,
        selector,
        found: true,
        outcome: issues.length > 0 ? ("fail" as const) : ("pass" as const),
        tolerancePx,
        issues,
        excluded,
        truncated,
      };
    });

    return { align, gap, clip, overlap };
  };
}

export function buildLayoutLintAnnotateScript(): (result: LayoutLintResult) => void {
  return (result) => {
    const ROOT_ID = "__harnery-layout-lint-annotations__";
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:0;overflow:visible;pointer-events:none;z-index:2147483646";
    document.body.appendChild(root);
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    const box = (rect: LayoutRect, color: string, label: string): void => {
      const node = document.createElement("div");
      node.style.cssText = `position:absolute;left:${rect.x + scrollX}px;top:${rect.y + scrollY}px;width:${rect.width}px;height:${rect.height}px;border:2px solid ${color};box-sizing:border-box;background:${color}1a;pointer-events:none`;
      const tag = document.createElement("div");
      tag.textContent = label.slice(0, 120);
      tag.style.cssText = `position:absolute;left:0;top:-18px;background:${color};color:white;font:12px/1.4 system-ui,sans-serif;padding:1px 5px;border-radius:3px;white-space:nowrap`;
      node.appendChild(tag);
      root.appendChild(node);
    };

    for (const check of result.align) {
      for (const cluster of check.clusters) {
        for (const child of cluster.children) {
          box(
            child.rect,
            child.fail ? "#ef4444" : "#10b981",
            `align ${child.deltaPx.toFixed(1)}px`,
          );
        }
      }
    }
    for (const check of result.gap) {
      for (const cluster of check.clusters) {
        for (const pair of cluster.pairs) {
          if (pair.fail) box(pair.after.rect, "#f97316", `gap ${pair.observedGapPx.toFixed(1)}px`);
        }
      }
    }
    for (const check of result.clip) {
      for (const issue of check.issues) {
        box(issue.element.rect, "#d946ef", `clip ${issue.maxOverrunPx.toFixed(1)}px`);
      }
    }
    for (const check of result.overlap) {
      for (const issue of check.issues) {
        box(issue.intersection, "#e11d48", `overlap ${issue.areaPx.toFixed(0)}px²`);
      }
    }
  };
}

export function buildClearLayoutLintAnnotationsScript(): () => void {
  return () => {
    document.getElementById("__harnery-layout-lint-annotations__")?.remove();
  };
}
