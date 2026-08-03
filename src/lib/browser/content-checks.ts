// Content-level checks for `harn browse` — the failures a human still catches
// by eye that rendered-geometry checks miss:
//
//   placeholder  Unrendered template tokens / bound-value tells that leaked to
//                the page: `${x}`, `{{x}}`, `[object Object]`, `Invalid Date`,
//                `NaN`, or an element whose whole text is literally
//                "undefined" / "null".
//   image        <img> that failed to load (naturalWidth 0), is still loading,
//                or is visibly stretched (rendered aspect ratio far from the
//                intrinsic one, with an object-fit that does not correct it).
//   truncation   Text actively cut off by an ellipsis or -webkit-line-clamp —
//                i.e. the author asked to truncate AND the content overflows.
//   contrast     Rendered text below the WCAG AA contrast ratio against its
//                effective background. Runs at whatever theme the page is in,
//                so pair it with a theme toggle to cover light + dark.
//
// One evaluator runs every requested check in a single page.evaluate so the
// shared helpers (label, hidden walk, scroll offsets) are defined once. The
// returned function is serialized into the page by Playwright and cannot reach
// module-scope closures, which is why the helpers are nested.

export interface CheckRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlaceholderHit {
  label: string;
  token: string;
  kind: "js-template" | "mustache" | "object" | "invalid-date" | "nan" | "empty-binding";
  snippet: string;
  rect: CheckRect;
}
export interface PlaceholderResult {
  rule: "placeholder";
  found: boolean;
  outcome: "pass" | "fail";
  scanned: number;
  truncated: boolean;
  hits: PlaceholderHit[];
}

export interface ImageHit {
  label: string;
  src: string;
  reason: "missing" | "loading" | "stretched";
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  renderedHeight: number;
  objectFit: string;
  rect: CheckRect;
}
export interface ImageHealthResult {
  rule: "image";
  found: boolean;
  outcome: "pass" | "fail";
  scanned: number;
  truncated: boolean;
  issues: ImageHit[];
}

export interface TruncationHit {
  label: string;
  axis: "x" | "y";
  how: "ellipsis" | "line-clamp";
  overflowPx: number;
  snippet: string;
  rect: CheckRect;
}
export interface TruncationResult {
  rule: "truncation";
  found: boolean;
  outcome: "pass" | "fail";
  scanned: number;
  truncated: boolean;
  hits: TruncationHit[];
}

export interface ContrastHit {
  label: string;
  ratio: number;
  required: number;
  color: string;
  background: string;
  largeText: boolean;
  snippet: string;
  outcome: "fail" | "unknown";
  rect: CheckRect;
}
export interface ContrastResult {
  rule: "contrast";
  found: boolean;
  outcome: "pass" | "fail" | "unknown";
  scanned: number;
  truncated: boolean;
  hits: ContrastHit[];
}

export interface ContentChecksRequest {
  placeholder: { scope: string | null } | null;
  image: { scope: string | null; tolerance: number } | null;
  truncation: { scope: string | null; tolerance: number } | null;
  contrast: { scope: string | null } | null;
}

export interface ContentChecksResult {
  placeholder?: PlaceholderResult;
  image?: ImageHealthResult;
  truncation?: TruncationResult;
  contrast?: ContrastResult;
}

export function buildContentChecks(): (request: ContentChecksRequest) => ContentChecksResult {
  return (request) => {
    const NODE_CAP = 6000;
    const HIT_CAP = 100;

    const sx = window.scrollX;
    const sy = window.scrollY;

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
        const cv = (style as CSSStyleDeclaration & { contentVisibility?: string })
          .contentVisibility;
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.visibility === "collapse" ||
          Number.parseFloat(style.opacity || "1") === 0 ||
          cv === "hidden"
        ) {
          return true;
        }
        current = current.parentElement;
      }
      return false;
    };

    const docRect = (r: DOMRect): CheckRect => ({
      x: Math.round(r.x + sx),
      y: Math.round(r.y + sy),
      width: Math.round(r.width),
      height: Math.round(r.height),
    });

    const rootOf = (scope: string | null): Element | null =>
      scope ? document.querySelector(scope) : document.body;

    const snippetOf = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 80);

    // ---- placeholder --------------------------------------------------------
    let placeholder: PlaceholderResult | undefined;
    if (request.placeholder) {
      const root = rootOf(request.placeholder.scope);
      const hits: PlaceholderHit[] = [];
      let scanned = 0;
      let truncated = false;
      const EMPTY = new Set(["undefined", "null", "NaN", "[object Object]", "Invalid Date"]);
      // Ordered so the most specific token wins the label for a given match.
      const TOKENS: Array<{ re: RegExp; kind: PlaceholderHit["kind"] }> = [
        { re: /\$\{[^}]{1,120}\}/g, kind: "js-template" },
        { re: /\{\{[^}]{1,120}\}\}/g, kind: "mustache" },
        { re: /\[object [A-Z][A-Za-z]+\]/g, kind: "object" },
        { re: /\bInvalid Date\b/g, kind: "invalid-date" },
        { re: /(?<![A-Za-z])NaN(?![A-Za-z])/g, kind: "nan" },
      ];
      const rectForTextNode = (node: Text, index: number, length: number): CheckRect | null => {
        try {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, Math.min(index + length, node.nodeValue?.length ?? index));
          const r = range.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) return null;
          return docRect(r);
        } catch {
          return null;
        }
      };
      if (root && !isHidden(root)) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (scanned >= NODE_CAP) {
            truncated = true;
            break;
          }
          const parent = node.parentElement;
          if (!parent) continue;
          if (["SCRIPT", "STYLE", "NOSCRIPT", "TEXTAREA"].includes(parent.tagName)) continue;
          if (isHidden(parent)) continue;
          scanned++;
          const value = node.nodeValue ?? "";
          for (const { re, kind } of TOKENS) {
            re.lastIndex = 0;
            for (const m of value.matchAll(re)) {
              if (m.index === undefined) continue;
              const rect = rectForTextNode(node as Text, m.index, m[0].length) ?? {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
              };
              hits.push({
                label: labelOf(parent),
                token: m[0],
                kind,
                snippet: snippetOf(value),
                rect,
              });
              if (hits.length >= HIT_CAP) break;
            }
            if (hits.length >= HIT_CAP) break;
          }
          if (hits.length >= HIT_CAP) {
            truncated = true;
            break;
          }
        }
        // Whole-element-equals sweep for bare undefined/null (prose-safe: only
        // when the trimmed text of a leaf element is exactly the tell).
        if (hits.length < HIT_CAP) {
          const leaves = root.querySelectorAll("*");
          for (let i = 0; i < leaves.length && i < NODE_CAP; i++) {
            const el = leaves[i];
            if (!el || el.children.length > 0) continue;
            if (isHidden(el)) continue;
            const text = (el.textContent ?? "").trim();
            if (!EMPTY.has(text)) continue;
            const r = el.getBoundingClientRect();
            hits.push({
              label: labelOf(el),
              token: text,
              kind: "empty-binding",
              snippet: text,
              rect: docRect(r),
            });
            if (hits.length >= HIT_CAP) {
              truncated = true;
              break;
            }
          }
        }
      }
      placeholder = {
        rule: "placeholder",
        found: root !== null,
        outcome: root && hits.length === 0 ? "pass" : "fail",
        scanned,
        truncated,
        hits,
      };
    }

    // ---- image health -------------------------------------------------------
    let image: ImageHealthResult | undefined;
    if (request.image) {
      const root = rootOf(request.image.scope);
      const tol = request.image.tolerance;
      const issues: ImageHit[] = [];
      let scanned = 0;
      let truncated = false;
      if (root) {
        const imgs = root.querySelectorAll("img");
        for (let i = 0; i < imgs.length; i++) {
          const img = imgs[i] as HTMLImageElement | undefined;
          if (!img) continue;
          if (isHidden(img)) continue;
          if (scanned >= NODE_CAP) {
            truncated = true;
            break;
          }
          scanned++;
          const rect = img.getBoundingClientRect();
          const objectFit = getComputedStyle(img).objectFit || "fill";
          let reason: ImageHit["reason"] | null = null;
          if (!img.complete) {
            reason = "loading";
          } else if (img.naturalWidth === 0 || img.naturalHeight === 0) {
            reason = "missing";
          } else if (
            rect.width > 1 &&
            rect.height > 1 &&
            objectFit !== "cover" &&
            objectFit !== "contain" &&
            objectFit !== "scale-down"
          ) {
            const renderedAR = rect.width / rect.height;
            const naturalAR = img.naturalWidth / img.naturalHeight;
            const deviation = Math.abs(renderedAR - naturalAR) / naturalAR;
            if (deviation > tol) reason = "stretched";
          }
          if (!reason) continue;
          issues.push({
            label: labelOf(img),
            src: img.currentSrc || img.src || "(none)",
            reason,
            naturalWidth: img.naturalWidth,
            naturalHeight: img.naturalHeight,
            renderedWidth: Math.round(rect.width),
            renderedHeight: Math.round(rect.height),
            objectFit,
            rect: docRect(rect),
          });
          if (issues.length >= HIT_CAP) {
            truncated = true;
            break;
          }
        }
      }
      // "loading" alone is not a failure — the capture may have raced the load.
      const failing = issues.some((i) => i.reason !== "loading");
      image = {
        rule: "image",
        found: root !== null,
        outcome: !root || failing ? "fail" : "pass",
        scanned,
        truncated,
        issues,
      };
    }

    // ---- truncation ---------------------------------------------------------
    let truncation: TruncationResult | undefined;
    if (request.truncation) {
      const root = rootOf(request.truncation.scope);
      const tol = request.truncation.tolerance;
      const hits: TruncationHit[] = [];
      let scanned = 0;
      let truncated = false;
      if (root) {
        const all = root.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const el = all[i] as HTMLElement | undefined;
          if (!el) continue;
          if (scanned >= NODE_CAP) {
            truncated = true;
            break;
          }
          const text = (el.textContent ?? "").trim();
          if (!text) continue;
          if (isHidden(el)) continue;
          scanned++;
          const style = getComputedStyle(el);
          // Horizontal: an active single-line ellipsis.
          if (
            style.textOverflow === "ellipsis" &&
            (style.overflowX === "hidden" || style.overflowX === "clip") &&
            el.scrollWidth - el.clientWidth > tol
          ) {
            hits.push({
              label: labelOf(el),
              axis: "x",
              how: "ellipsis",
              overflowPx: Math.round(el.scrollWidth - el.clientWidth),
              snippet: snippetOf(text),
              rect: docRect(el.getBoundingClientRect()),
            });
          } else {
            // Vertical: an active -webkit-line-clamp.
            const clampRaw = style.getPropertyValue("-webkit-line-clamp");
            const clamp = Number.parseInt(clampRaw, 10);
            if (Number.isFinite(clamp) && clamp > 0 && el.scrollHeight - el.clientHeight > tol) {
              hits.push({
                label: labelOf(el),
                axis: "y",
                how: "line-clamp",
                overflowPx: Math.round(el.scrollHeight - el.clientHeight),
                snippet: snippetOf(text),
                rect: docRect(el.getBoundingClientRect()),
              });
            }
          }
          if (hits.length >= HIT_CAP) {
            truncated = true;
            break;
          }
        }
      }
      truncation = {
        rule: "truncation",
        found: root !== null,
        outcome: !root || hits.length > 0 ? "fail" : "pass",
        scanned,
        truncated,
        hits,
      };
    }

    // ---- contrast -----------------------------------------------------------
    let contrast: ContrastResult | undefined;
    if (request.contrast) {
      const root = rootOf(request.contrast.scope);
      const hits: ContrastHit[] = [];
      let scanned = 0;
      let truncated = false;

      const parseColor = (value: string): { r: number; g: number; b: number; a: number } | null => {
        const m = value.match(/rgba?\(([^)]+)\)/);
        if (!m?.[1]) return null;
        const parts = m[1].split(",").map((p) => Number.parseFloat(p.trim()));
        if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
        return { r: parts[0]!, g: parts[1]!, b: parts[2]!, a: parts[3] ?? 1 };
      };
      const lin = (c: number): number => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (r: number, g: number, b: number): number =>
        0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const over = (
        fg: { r: number; g: number; b: number; a: number },
        bg: { r: number; g: number; b: number },
      ) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
      });

      const hasDirectText = (el: Element): boolean => {
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? "").trim().length > 0) {
            return true;
          }
        }
        return false;
      };

      // Effective background: first opaque ancestor background-color. A
      // background-image or gradient anywhere in the chain makes it unknowable.
      const effectiveBg = (
        el: Element,
      ): { rgb: { r: number; g: number; b: number }; unknown: boolean } => {
        let current: Element | null = el;
        while (current) {
          const style = getComputedStyle(current);
          if (style.backgroundImage && style.backgroundImage !== "none") {
            return { rgb: { r: 255, g: 255, b: 255 }, unknown: true };
          }
          const bg = parseColor(style.backgroundColor);
          if (bg && bg.a >= 0.999) return { rgb: { r: bg.r, g: bg.g, b: bg.b }, unknown: false };
          current = current.parentElement;
        }
        // Fell through to the canvas: assume white (the common page default).
        return { rgb: { r: 255, g: 255, b: 255 }, unknown: false };
      };

      if (root) {
        const all = root.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (!el) continue;
          if (scanned >= NODE_CAP) {
            truncated = true;
            break;
          }
          if (!hasDirectText(el)) continue;
          if (isHidden(el)) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          scanned++;
          const style = getComputedStyle(el);
          const fg = parseColor(style.color);
          if (!fg) continue;
          const size = Number.parseFloat(style.fontSize) || 16;
          const weight = Number.parseInt(style.fontWeight, 10) || 400;
          const largeText = size >= 24 || (size >= 18.66 && weight >= 700);
          const required = largeText ? 3 : 4.5;
          const bg = effectiveBg(el);
          const composited = fg.a < 0.999 ? over(fg, bg.rgb) : { r: fg.r, g: fg.g, b: fg.b };
          const lFg = luminance(composited.r, composited.g, composited.b);
          const lBg = luminance(bg.rgb.r, bg.rgb.g, bg.rgb.b);
          const ratio = (Math.max(lFg, lBg) + 0.05) / (Math.min(lFg, lBg) + 0.05);
          const rounded = Math.round(ratio * 100) / 100;
          if (bg.unknown) {
            hits.push({
              label: labelOf(el),
              ratio: rounded,
              required,
              color: style.color,
              background: "(image/gradient)",
              largeText,
              snippet: snippetOf(el.textContent ?? ""),
              outcome: "unknown",
              rect: docRect(rect),
            });
          } else if (ratio < required) {
            hits.push({
              label: labelOf(el),
              ratio: rounded,
              required,
              color: style.color,
              background: style.backgroundColor,
              largeText,
              snippet: snippetOf(el.textContent ?? ""),
              outcome: "fail",
              rect: docRect(rect),
            });
          }
          if (hits.length >= HIT_CAP) {
            truncated = true;
            break;
          }
        }
      }
      const anyFail = hits.some((h) => h.outcome === "fail");
      const anyUnknown = hits.some((h) => h.outcome === "unknown");
      contrast = {
        rule: "contrast",
        found: root !== null,
        outcome: !root ? "fail" : anyFail ? "fail" : anyUnknown ? "unknown" : "pass",
        scanned,
        truncated,
        hits,
      };
    }

    const result: ContentChecksResult = {};
    if (placeholder) result.placeholder = placeholder;
    if (image) result.image = image;
    if (truncation) result.truncation = truncation;
    if (contrast) result.contrast = contrast;
    return result;
  };
}

export interface ContentAnnotationBox {
  rect: CheckRect;
  label: string;
  color: string;
}

export function buildContentAnnotateScript(): (args: { boxes: ContentAnnotationBox[] }) => void {
  return ({ boxes }) => {
    const ROOT_ID = "__bp-content-check-annotations__";
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText =
      "position:absolute;top:0;left:0;width:100%;height:0;overflow:visible;pointer-events:none;z-index:2147483646";
    document.body.appendChild(root);
    for (const b of boxes) {
      const node = document.createElement("div");
      node.style.cssText = `position:absolute;left:${b.rect.x - 2}px;top:${b.rect.y - 2}px;width:${Math.max(b.rect.width, 6) + 4}px;height:${Math.max(b.rect.height, 6) + 4}px;border:2px solid ${b.color};box-sizing:border-box;background:${b.color}1a;pointer-events:none`;
      const tag = document.createElement("div");
      tag.textContent = b.label.slice(0, 120);
      tag.style.cssText = `position:absolute;left:0;top:-18px;background:${b.color};color:#fff;font:12px/1.4 system-ui,sans-serif;padding:1px 5px;border-radius:3px;white-space:nowrap`;
      node.appendChild(tag);
      root.appendChild(node);
    }
  };
}

export function buildClearContentAnnotationsScript(): () => void {
  return () => {
    document.getElementById("__bp-content-check-annotations__")?.remove();
  };
}
