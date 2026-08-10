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

export interface CrowdPair {
  before: LayoutElementMeasurement;
  after: LayoutElementMeasurement;
  /** Edge separation along `axis` in CSS px; negative means the panels overlap. */
  separationPx: number;
  /** "y" = stacked, "x" = side by side, "overlap" = they intersect in 2D. */
  axis: "x" | "y" | "overlap";
  minGapPx: number;
  /** DOM label of the shared parent, so the fix location is obvious. */
  parentLabel: string;
  /**
   * Whether each consecutive sibling peer was a leaf panel or a wrapper that
   * contains panels. `before`/`after` always measure the nearest face panels
   * (a descendant when the peer is composite).
   */
  beforeKind: "panel" | "composite";
  afterKind: "panel" | "composite";
}

export interface CrowdResult {
  rule: "crowd";
  selector: string;
  found: boolean;
  outcome: LayoutOutcome;
  minGapPx: number;
  issues: CrowdPair[];
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
  crowd: Array<{ selector: string; minGapPx: number }>;
}

export interface LayoutLintResult {
  align: AlignResult[];
  gap: GapResult[];
  clip: ClipResult[];
  overlap: OverlapResult[];
  crowd: CrowdResult[];
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
    const CHILD_LIMIT = 1_000;
    const TEXT_LIMIT = 1_000;
    const ISSUE_LIMIT = 100;
    // Chromium geometry is fractional even when authored CSS is integral.
    // Differences below half a CSS pixel are rasterization noise, not clipping.
    const SUBPIXEL_EPSILON = 0.5;

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
        // A collapsed disclosure hides its content through the ::details-content
        // pseudo, which is not in the ancestor chain, so no computed style on a
        // real ancestor reports it. Without this, every closed accordion panel
        // reads as text clipped out of its container.
        const parent: Element | null = current.parentElement;
        if (
          parent instanceof HTMLDetailsElement &&
          !parent.open &&
          current.tagName !== "SUMMARY"
        ) {
          return true;
        }
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

    // A scroller hides content the same way a clip does, but the reader can
    // reach it. Content below the fold of a capped table or right of a wide
    // code block is not a layout defect, so an axis stops being checked at the
    // first ancestor that scrolls it. Constraints from ancestors INSIDE that
    // scroller still apply -- an overflow:hidden box within a scroller really
    // does cut its content off, and the scroller cannot reveal it.
    const scrollingStyle = (element: Element): { x: boolean; y: boolean } => {
      const style = getComputedStyle(element);
      const scrolls = new Set(["auto", "scroll"]);
      return { x: scrolls.has(style.overflowX), y: scrolls.has(style.overflowY) };
    };

    const unbounded = (): LayoutRect => ({
      x: Number.NEGATIVE_INFINITY,
      y: Number.NEGATIVE_INFINITY,
      left: Number.NEGATIVE_INFINITY,
      top: Number.NEGATIVE_INFINITY,
      right: Number.POSITIVE_INFINITY,
      bottom: Number.POSITIVE_INFINITY,
      width: Number.POSITIVE_INFINITY,
      height: Number.POSITIVE_INFINITY,
    });

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
      const containers = [...document.querySelectorAll(selector)];
      if (containers.length === 0) {
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
      let truncated = false;
      let measurementIndex = 0;

      const recordIssue = (
        element: LayoutElementMeasurement,
        allowed: LayoutRect,
        clippedBy: string,
        axes: { x: boolean; y: boolean } = { x: true, y: true },
      ): void => {
        const rect = element.rect;
        const overrun = {
          top: axes.y ? Math.max(0, allowed.top - rect.top) : 0,
          right: axes.x ? Math.max(0, rect.right - allowed.right) : 0,
          bottom: axes.y ? Math.max(0, rect.bottom - allowed.bottom) : 0,
          left: axes.x ? Math.max(0, allowed.left - rect.left) : 0,
        };
        const maxOverrunPx = Math.max(overrun.top, overrun.right, overrun.bottom, overrun.left);
        if (maxOverrunPx > tolerancePx + SUBPIXEL_EPSILON && issues.length < ISSUE_LIMIT) {
          issues.push({ element, clippedBy, overrun, maxOverrunPx });
        }
      };

      // Walk from `start` up to `container`, intersecting the allowed rect with
      // every ancestor that genuinely clips. `free` records an axis the reader
      // can scroll, after which nothing further constrains that axis -- the
      // scroller's own box still has to fit its outer chain, but its contents
      // are reachable and so are exempt.
      const clipChain = (
        start: Element | null,
        container: Element,
        seed: LayoutRect,
        seedLabel: string,
      ): { allowed: LayoutRect; clippedBy: string } => {
        let allowed = { ...seed };
        let clippedBy = seedLabel;
        const free = { x: false, y: false };
        let current: Element | null = start;
        while (current && container.contains(current)) {
          const style = getComputedStyle(current);
          if (style.clipPath && style.clipPath !== "none")
            unsupported.add(`${labelOf(current)}:clip-path`);
          if (style.transform && style.transform !== "none")
            unsupported.add(`${labelOf(current)}:transform`);
          // The container bounds by default even when it does not CSS-clip,
          // since it is the scope the caller asked about -- but a scroller
          // hands its axis back whether it is the scope or an ancestor.
          const scope = current === container;
          const scrolls = scrollingStyle(current);
          const css = scope ? { x: true, y: true } : clippingStyle(current);
          const clips = {
            x: css.x && !free.x && !scrolls.x,
            y: css.y && !free.y && !scrolls.y,
          };
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
          if (scrolls.x) free.x = true;
          if (scrolls.y) free.y = true;
          if (scope) break;
          current = current.parentElement;
        }
        return { allowed, clippedBy };
      };

      const textContainer = (node: Node, scope: Element): Element | null => {
        let current = node.parentElement;
        while (current && scope.contains(current)) {
          if (current instanceof SVGElement) return null;
          const display = getComputedStyle(current).display;
          if (display !== "inline" && display !== "contents") return current;
          if (current === scope) return current;
          current = current.parentElement;
        }
        return scope;
      };

      for (const container of containers) {
        const descendants = [...container.querySelectorAll("*")];
        if (descendants.length > CHILD_LIMIT) truncated = true;
        descendants.slice(0, CHILD_LIMIT).forEach((element) => {
          const index = measurementIndex++;
          if (isHidden(element)) {
            excluded.push({ index, tag: element.tagName.toLowerCase(), reason: "hidden" });
            return;
          }
          const rect = element.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) {
            excluded.push({ index, tag: element.tagName.toLowerCase(), reason: "zero-area" });
            return;
          }
          const chain = clipChain(
            element.parentElement,
            container,
            unbounded(),
            labelOf(container),
          );
          recordIssue(measure(element, index, false), chain.allowed, chain.clippedBy);
        });

        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let textCount = 0;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (textCount >= TEXT_LIMIT) {
            truncated = true;
            break;
          }
          const value = node.nodeValue ?? "";
          if (!/\S/.test(value)) continue;
          const parent = node.parentElement;
          if (
            !parent ||
            ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName) ||
            isHidden(parent)
          ) {
            continue;
          }
          const owner = textContainer(node, container);
          if (!owner) continue;
          let transformed = false;
          let current: Element | null = owner;
          while (current && container.contains(current)) {
            const transform = getComputedStyle(current).transform;
            if (transform && transform !== "none") {
              unsupported.add(`${labelOf(current)}:transform`);
              transformed = true;
              break;
            }
            if (current === container) break;
            current = current.parentElement;
          }
          if (transformed) continue;
          textCount++;
          // Text glyph boxes routinely extend a few pixels above/below their
          // line box. That is normal font paint, not clipping. Constrain text
          // horizontally to its nearest block owner, vertically to the scope,
          // and on either axis where a CSS ancestor actually clips.
          const seed = unbounded();
          // Constrain text horizontally to its nearest block owner -- unless
          // that owner scrolls sideways, where running past its edge is how a
          // long line is meant to behave.
          if (!scrollingStyle(owner).x) {
            const ownerRect = paddingRect(owner);
            seed.left = ownerRect.left;
            seed.right = ownerRect.right;
            seed.x = seed.left;
            seed.width = Math.max(0, seed.right - seed.left);
          }
          const chain = clipChain(owner, container, seed, labelOf(owner));
          const allowed = chain.allowed;
          const clippedBy = chain.clippedBy;
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const fragment of [...range.getClientRects()]) {
            if (fragment.width <= 0 || fragment.height <= 0) continue;
            const index = measurementIndex++;
            recordIssue(
              {
                index,
                tag: parent.tagName.toLowerCase(),
                label: labelOf(parent),
                snippet: value.replace(/\s+/g, " ").trim().slice(0, 160),
                source: "text",
                rect: rectOf(fragment),
              },
              allowed,
              clippedBy,
            );
          }
        }
      }
      if (issues.length >= ISSUE_LIMIT) truncated = true;
      // Border radius keeps the rectangular padding-box contract; only shapes
      // the rectangle cannot certify contribute to unsupported geometry.
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

    // A "panel" here means a card-like callout — a block that reads as its own
    // standalone box: a full (4-side) border, a modest corner radius, or a
    // box-shadow. Two flush cards read as one merged block, which `overlap`
    // (needs a 2D intersection) and `gap` (flags uneven spacing, so a
    // uniformly-flush stack passes) both miss.
    //
    // Crowd peers are also *composites*: in-flow siblings that are not panels
    // themselves but contain at least one panel descendant (a card grid, a
    // flow of cards, etc.). Comparing only leaf panels missed the common case
    // where a wrapper-of-cards sits flush against the next card. Separation is
    // measured between the nearest face panels inside each peer, not the
    // wrapper boxes, so a tall section with a card near the top and prose
    // below does not false-fail against the next sibling.
    //
    // Deliberately NOT flagged: structural elements that are flush BY DESIGN —
    // table cells, list/definition rows, and divided segments (a bg-only cell
    // in a `gap:1px` strip). Those have no card boundary of their own, so the
    // test below excludes them without a special-case allowlist. Pills, chips,
    // and badges (radius ≥ half their smaller side) are inline controls, not
    // layout cards, and are excluded too. Plain blocks with no panel chrome
    // and no panel descendants stay out of the peer list.
    const PARENT_LIMIT = 2000;
    const PANEL_DESCENDANT_LIMIT = 100;
    const OVERLAP_EPS = 1;
    const STRUCTURAL_TAGS = new Set([
      "TD",
      "TH",
      "TR",
      "THEAD",
      "TBODY",
      "TFOOT",
      "COL",
      "COLGROUP",
    ]);

    const maxCornerRadiusPx = (style: CSSStyleDeclaration, minDim: number): number => {
      const corners = [
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-right-radius",
        "border-bottom-left-radius",
      ];
      let max = 0;
      for (const corner of corners) {
        const token = (style.getPropertyValue(corner) || "").trim().split(/\s+/)[0] ?? "";
        const value = token.endsWith("%")
          ? (Number.parseFloat(token) / 100) * minDim
          : Number.parseFloat(token) || 0;
        if (value > max) max = value;
      }
      return max;
    };

    const isPanel = (element: Element): boolean => {
      if (STRUCTURAL_TAGS.has(element.tagName)) return false;
      const style = getComputedStyle(element);
      if (style.display.startsWith("table") || style.display.startsWith("inline")) return false;
      if (style.boxShadow && style.boxShadow !== "none") return true;
      const sides = ["top", "right", "bottom", "left"];
      const fullBorder = sides.every((side) => {
        const width = Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0;
        const lineStyle = style.getPropertyValue(`border-${side}-style`);
        return width > 0 && lineStyle !== "none" && lineStyle !== "";
      });
      if (fullBorder) return true;
      const rect = element.getBoundingClientRect();
      const minDim = Math.min(rect.width, rect.height);
      const radius = maxCornerRadiusPx(style, minDim);
      // A card has a modest radius; a pill/circle (radius ≥ half its short side)
      // is a control, not a card.
      return radius >= 3 && radius < minDim / 2 - 1;
    };

    const isInFlowBox = (element: Element): boolean => {
      if (isHidden(element)) return false;
      const style = getComputedStyle(element);
      if (style.position === "absolute" || style.position === "fixed") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    /** Leaf panel faces that represent a crowd peer (self, or descendants). */
    const collectPanelFaces = (
      element: Element,
      selfIsPanel: boolean,
    ): LayoutElementMeasurement[] => {
      if (selfIsPanel) return [measure(element, 0, false)];
      const faces: LayoutElementMeasurement[] = [];
      const descendants = element.querySelectorAll("*");
      for (let i = 0; i < descendants.length && faces.length < PANEL_DESCENDANT_LIMIT; i++) {
        const child = descendants[i];
        if (!child || !isInFlowBox(child) || !isPanel(child)) continue;
        faces.push(measure(child, faces.length, false));
      }
      return faces;
    };

    // In-flow, visible, non-zero-area direct children that are crowd peers:
    // leaf panels, or composites that wrap at least one panel. Non-peer
    // siblings (plain prose, arrows, spacers) drop out of the list so two
    // panels separated only by chrome still get a face-to-face check.
    const collectCrowdPeers = (
      parent: Element,
    ): Array<{
      kind: "panel" | "composite";
      faces: LayoutElementMeasurement[];
    }> => {
      const out: Array<{
        kind: "panel" | "composite";
        faces: LayoutElementMeasurement[];
      }> = [];
      const children = [...parent.children];
      for (let index = 0; index < children.length && index < CHILD_LIMIT; index++) {
        const element = children[index];
        if (!element || !isInFlowBox(element)) continue;
        const selfIsPanel = isPanel(element);
        const faces = collectPanelFaces(element, selfIsPanel);
        if (faces.length === 0) continue;
        out.push({
          kind: selfIsPanel ? "panel" : "composite",
          faces,
        });
      }
      return out;
    };

    const separationOf = (
      a: LayoutElementMeasurement,
      b: LayoutElementMeasurement,
    ): { axis: "x" | "y" | "overlap" | "none"; sep: number } => {
      const ra = a.rect;
      const rb = b.rect;
      const yOverlap = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      const xOverlap = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const sharesY = yOverlap > OVERLAP_EPS;
      const sharesX = xOverlap > OVERLAP_EPS;
      if (sharesX && sharesY) return { axis: "overlap", sep: -Math.min(xOverlap, yOverlap) };
      if (sharesX) {
        const [upper, lower] = ra.top <= rb.top ? [ra, rb] : [rb, ra];
        return { axis: "y", sep: lower.top - upper.bottom };
      }
      if (sharesY) {
        const [left, right] = ra.left <= rb.left ? [ra, rb] : [rb, ra];
        return { axis: "x", sep: right.left - left.right };
      }
      // Diagonal (e.g. a grid row wrap): not edge-adjacent, so never crowded.
      const vGap = Math.max(ra.top, rb.top) - Math.min(ra.bottom, rb.bottom);
      const hGap = Math.max(ra.left, rb.left) - Math.min(ra.right, rb.right);
      return { axis: "none", sep: Math.max(vGap, hGap) };
    };

    /** Tightest edge-adjacent face pair across two peers' panel faces. */
    const nearestCrowdPair = (
      beforeFaces: LayoutElementMeasurement[],
      afterFaces: LayoutElementMeasurement[],
    ): {
      before: LayoutElementMeasurement;
      after: LayoutElementMeasurement;
      axis: "x" | "y" | "overlap";
      sep: number;
    } | null => {
      let best: {
        before: LayoutElementMeasurement;
        after: LayoutElementMeasurement;
        axis: "x" | "y" | "overlap";
        sep: number;
      } | null = null;
      for (const before of beforeFaces) {
        for (const after of afterFaces) {
          const { axis, sep } = separationOf(before, after);
          if (axis === "none") continue;
          if (best === null || sep < best.sep) {
            best = { before, after, axis, sep };
          }
        }
      }
      return best;
    };

    const crowd = request.crowd.map(({ selector, minGapPx }): CrowdResult => {
      const container = document.querySelector(selector);
      if (!(container instanceof Element)) {
        return {
          rule: "crowd" as const,
          selector,
          found: false,
          outcome: "fail" as const,
          minGapPx,
          issues: [],
          truncated: false,
        };
      }
      const parents: Element[] = [container, ...container.querySelectorAll("*")];
      const issues: CrowdPair[] = [];
      let truncated = parents.length > PARENT_LIMIT;
      const limit = Math.min(parents.length, PARENT_LIMIT);
      for (let p = 0; p < limit; p++) {
        const parent = parents[p]!;
        const peers = collectCrowdPeers(parent);
        for (let i = 1; i < peers.length; i++) {
          const beforePeer = peers[i - 1]!;
          const afterPeer = peers[i]!;
          const best = nearestCrowdPair(beforePeer.faces, afterPeer.faces);
          if (!best) continue;
          if (best.sep < minGapPx) {
            issues.push({
              before: best.before,
              after: best.after,
              separationPx: best.sep,
              axis: best.axis,
              minGapPx,
              parentLabel: labelOf(parent),
              beforeKind: beforePeer.kind,
              afterKind: afterPeer.kind,
            });
            if (issues.length >= ISSUE_LIMIT) {
              truncated = true;
              break;
            }
          }
        }
        if (issues.length >= ISSUE_LIMIT) break;
      }
      return {
        rule: "crowd" as const,
        selector,
        found: true,
        outcome: issues.length > 0 ? ("fail" as const) : ("pass" as const),
        minGapPx,
        issues,
        truncated,
      };
    });

    return { align, gap, clip, overlap, crowd };
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
    for (const check of result.crowd) {
      for (const issue of check.issues) {
        // Draw the touching seam: a thin strip along the edge the two panels
        // share, so "no space here" is visible even at zero separation.
        const a = issue.before.rect;
        const b = issue.after.rect;
        const seam: LayoutRect =
          issue.axis === "x"
            ? {
                x: Math.min(a.right, b.right),
                y: Math.max(a.top, b.top),
                width: Math.max(2, Math.abs(issue.separationPx)),
                height: Math.max(1, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
                top: Math.max(a.top, b.top),
                right: 0,
                bottom: 0,
                left: Math.min(a.right, b.right),
              }
            : {
                x: Math.max(a.left, b.left),
                y: Math.min(a.bottom, b.bottom),
                width: Math.max(1, Math.min(a.right, b.right) - Math.max(a.left, b.left)),
                height: Math.max(2, Math.abs(issue.separationPx)),
                top: Math.min(a.bottom, b.bottom),
                right: 0,
                bottom: 0,
                left: Math.max(a.left, b.left),
              };
        box(seam, "#14b8a6", `crowd ${issue.separationPx.toFixed(1)}px`);
      }
    }
  };
}

export function buildClearLayoutLintAnnotationsScript(): () => void {
  return () => {
    document.getElementById("__harnery-layout-lint-annotations__")?.remove();
  };
}
