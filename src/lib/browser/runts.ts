// Runt detection for `harn browse` — a runt (a.k.a. "widow word") is a single
// short word sitting alone on the LAST visual line of a text block. Not a
// page-break issue; it happens mid-page and just looks sloppy.
//
// Detection is by COUNTING WORDS on the last visual line (== 1 word), NOT by
// relative width: a width threshold misses runts in narrow columns (how-to
// steps, a right-aligned contact box) where one short word still fills a big
// slice of the skinny column. "Text block" = element with real text whose
// element children are all inline — a <p>-only pass silently skips
// pull-quotes, blurbs and captions that ship as <div>/<blockquote>.
//
// Atomic tokens (URLs, emails, phone numbers) are excluded — they can't be
// rebalanced and usually sit on their own line by design. The detector can't
// catch a runt that is itself one long word; eyeball as a final pass.
//
// The word-level line mapping (per-word Range rects grouped by line top) was
// first built for the paged.js print-book lint; this is the generalized
// live-page port.

export interface RuntHit {
  /** Human label for the owning block: `tag#id` / `tag.class` / `tag`. */
  block: string;
  /** The lone word on the last visual line (trailing punctuation included). */
  word: string;
  /** First ~80 chars of the block's text, for locating it. */
  snippet: string;
  /** Document-relative rect of the runt word (scroll offsets applied). */
  rect: { x: number; y: number; width: number; height: number };
  /** Number of visual lines in the block. */
  lines: number;
}

export interface RuntsResult {
  /** Text blocks scanned (post length/inline-children filters). */
  scannedBlocks: number;
  /** True when the block sweep hit the internal cap (very large page). */
  truncated: boolean;
  runts: RuntHit[];
}

/**
 * Build the JS function passed to `page.evaluate`. `scope` narrows the sweep
 * to one container (null = whole body); `minChars` filters out tiny labels
 * that can't meaningfully wrap (default 40).
 */
export function buildRuntsCheck(): (args: {
  scope: string | null;
  minChars: number;
}) => RuntsResult {
  return ({ scope, minChars }) => {
    const INLINE = new Set([
      "B",
      "I",
      "EM",
      "STRONG",
      "SPAN",
      "A",
      "BR",
      "SMALL",
      "SUP",
      "SUB",
      "U",
      "MARK",
      "CODE",
      "ABBR",
      "TIME",
      "WBR",
    ]);
    const ATOMIC = /@|https?:|\.(com|org|net|io|co)\b|\d-\d{3}/;
    const BLOCK_CAP = 5000;
    const RUNT_CAP = 50;

    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) return { scannedBlocks: 0, truncated: false, runts: [] };

    const sx = window.scrollX;
    const sy = window.scrollY;

    const label = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      const cls = typeof el.className === "string" ? el.className.trim() : "";
      if (cls) return `${tag}.${cls.split(/\s+/).slice(0, 2).join(".")}`;
      return tag;
    };

    const all = root.querySelectorAll("*");
    const runts: RuntHit[] = [];
    let scanned = 0;
    let truncated = false;

    for (let i = 0; i < all.length; i++) {
      const el = all[i];
      if (!el) continue;
      const text = el.textContent ?? "";
      if (text.trim().length < minChars) continue;
      let allInline = true;
      for (const c of el.children) {
        if (!INLINE.has(c.tagName)) {
          allInline = false;
          break;
        }
      }
      if (!allInline) continue;
      const elRect = el.getBoundingClientRect();
      if (elRect.width <= 0 || elRect.height <= 0) continue;

      if (scanned >= BLOCK_CAP) {
        truncated = true;
        break;
      }
      scanned++;

      // Map every word to its visual line by rounding the Range rect top.
      const lines = new Map<number, { words: string[]; last: DOMRect }>();
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        const value = n.nodeValue ?? "";
        for (const m of value.matchAll(/\S+/g)) {
          const r = document.createRange();
          r.setStart(n, m.index);
          r.setEnd(n, m.index + m[0].length);
          const rect = r.getBoundingClientRect();
          if (!rect.width) continue;
          const top = Math.round(rect.top);
          const entry = lines.get(top);
          if (entry) {
            entry.words.push(m[0]);
            entry.last = rect;
          } else {
            lines.set(top, { words: [m[0]], last: rect });
          }
        }
      }
      const tops = [...lines.keys()].sort((a, b) => a - b);
      if (tops.length < 2) continue; // single line, no runt risk
      const lastTop = tops[tops.length - 1];
      const last = lastTop === undefined ? undefined : lines.get(lastTop);
      if (last?.words.length !== 1) continue;
      const word = last.words[0] ?? "";
      if (ATOMIC.test(word)) continue;

      runts.push({
        block: label(el),
        word,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 80),
        rect: {
          x: Math.round(last.last.x + sx),
          y: Math.round(last.last.y + sy),
          width: Math.round(last.last.width),
          height: Math.round(last.last.height),
        },
        lines: tops.length,
      });
      if (runts.length >= RUNT_CAP) {
        truncated = true;
        break;
      }
    }

    return { scannedBlocks: scanned, truncated, runts };
  };
}

/**
 * Annotate runt hits onto the live page before the screenshot. Uses a
 * document-absolute root (not fixed-inset like the other check overlays)
 * because runts are usually below the fold and the rects are document
 * coordinates — this keeps boxes aligned on full-page captures.
 */
export function buildRuntsAnnotateScript(): (args: { runts: RuntHit[] }) => void {
  return ({ runts }) => {
    const ROOT_ID = "__bp-check-runt-annotations__";
    document.getElementById(ROOT_ID)?.remove();
    const root = document.createElement("div");
    root.id = ROOT_ID;
    root.style.cssText =
      "position: absolute; top: 0; left: 0; width: 100%; height: 0; overflow: visible; pointer-events: none; z-index: 2147483646;";
    document.body.appendChild(root);

    for (const hit of runts) {
      const box = document.createElement("div");
      box.style.cssText = `
        position: absolute;
        left: ${hit.rect.x - 3}px;
        top: ${hit.rect.y - 3}px;
        width: ${hit.rect.width + 6}px;
        height: ${hit.rect.height + 6}px;
        border: 2px solid #d946ef;
        box-sizing: border-box;
        background: #d946ef1a;
        pointer-events: none;
      `;
      const tag = document.createElement("div");
      tag.textContent = `runt: …${hit.word} (${hit.block})`;
      tag.style.cssText = `
        position: absolute;
        left: 0;
        top: -18px;
        background: #d946ef;
        color: #fff;
        font: 12px/1.4 -apple-system, system-ui, sans-serif;
        padding: 1px 6px;
        border-radius: 3px;
        white-space: nowrap;
        pointer-events: none;
      `;
      box.appendChild(tag);
      root.appendChild(box);
    }
  };
}

export function buildClearRuntsAnnotationsScript(): () => void {
  return () => {
    document.getElementById("__bp-check-runt-annotations__")?.remove();
  };
}
