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
  /** Requested selector scope, or null for the document body. */
  scope: string | null;
  /** False when a requested selector matched nothing. */
  found: boolean;
  /** Unknown means the sweep hit a safety cap before proving the page clean. */
  outcome: "pass" | "fail" | "unknown";
  /** Text blocks scanned (post length/inline-children filters). */
  scannedBlocks: number;
  /** True when the sweep reached its findings limit or the internal block cap. */
  truncated: boolean;
  runts: RuntHit[];
}

/**
 * Build the JS function passed to `page.evaluate`. `scope` narrows the sweep
 * to one container (null = whole body); `minChars` filters out tiny labels
 * that can't meaningfully wrap (default 40). `maxFindings` bounds the retained
 * failure list (default 50; integer 1..5000), not the separate 5000-block cap.
 */
export function buildRuntsCheck(): (args: {
  scope: string | null;
  minChars: number;
  maxFindings?: number;
}) => RuntsResult {
  return ({ scope, minChars, maxFindings = 50 }) => {
    // page.evaluate has no module closure: validate this boundary too, even
    // when a caller evaluates the built function without the Browser client.
    if (!Number.isInteger(maxFindings) || maxFindings < 1 || maxFindings > 5000) {
      throw new Error("maxFindings must be an integer from 1 to 5000.");
    }
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
    const RUNT_CAP = maxFindings;

    const root = scope ? document.querySelector(scope) : document.body;
    if (!root) {
      return {
        scope,
        found: false,
        outcome: "fail",
        scannedBlocks: 0,
        truncated: false,
        runts: [],
      };
    }

    const sx = window.scrollX;
    const sy = window.scrollY;

    const label = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      const cls = typeof el.className === "string" ? el.className.trim() : "";
      if (cls) return `${tag}.${cls.split(/\s+/).slice(0, 2).join(".")}`;
      return tag;
    };

    // Include the scope itself. A caller commonly points directly at a <p>,
    // caption, or blurb; querySelectorAll("*") would otherwise scan nothing.
    const all = [root, ...root.querySelectorAll("*")];
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

      // Inline markup does not create word boundaries. Keep offsets into the
      // original text nodes so one Range can measure a word split by emphasis
      // or followed by punctuation in a separate node. BR still separates words.
      const segments: Array<{ node: Text; start: number; end: number }> = [];
      let content = "";
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (n instanceof Element && n.tagName === "BR") content += "\n";
        if (n.nodeType !== Node.TEXT_NODE) continue;
        const value = n.nodeValue ?? "";
        segments.push({
          node: n as Text,
          start: content.length,
          end: content.length + value.length,
        });
        content += value;
      }
      type Word = { value: string; rect: DOMRect; node: Node };
      const lines: Array<{ top: number; bottom: number; words: Map<number, Word> }> = [];
      let segmentIndex = 0;
      for (const m of content.matchAll(/\S+/g)) {
        const lexical = /[\p{L}\p{N}]/u.exec(m[0]);
        if (!lexical) continue; // punctuation alone is not an orphan word
        const end = m.index + m[0].length;
        while (segments[segmentIndex] && segments[segmentIndex]!.end <= m.index) segmentIndex++;
        const first = segments[segmentIndex];
        if (!first) continue;
        let endIndex = segmentIndex;
        while (segments[endIndex] && segments[endIndex]!.end < end) endIndex++;
        const final = segments[endIndex];
        if (!final) continue;
        let wordIndex = segmentIndex;
        while (segments[wordIndex]!.end <= m.index + lexical.index) wordIndex++;
        const wordNode = segments[wordIndex]!.node;
        const range = document.createRange();
        range.setStart(first.node, m.index - first.start);
        range.setEnd(final.node, end - final.start);
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          // Different inline fonts have different glyph tops on the same line.
          // Require substantial vertical overlap rather than exact rounded tops.
          let line = lines.find(
            (candidate) =>
              Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top) >
              Math.min(candidate.bottom - candidate.top, rect.height) / 2,
          );
          if (!line) {
            line = { top: rect.top, bottom: rect.bottom, words: new Map() };
            lines.push(line);
          }
          line.top = Math.min(line.top, rect.top);
          line.bottom = Math.max(line.bottom, rect.bottom);
          const previous = line.words.get(m.index)?.rect;
          const box = previous
            ? new DOMRect(
                Math.min(previous.left, rect.left),
                Math.min(previous.top, rect.top),
                Math.max(previous.right, rect.right) - Math.min(previous.left, rect.left),
                Math.max(previous.bottom, rect.bottom) - Math.min(previous.top, rect.top),
              )
            : rect;
          line.words.set(m.index, { value: m[0], rect: box, node: wordNode });
        }
      }
      lines.sort((a, b) => a.top - b.top);
      if (lines.length < 2) continue; // single line, no runt risk
      const lastLine = lines[lines.length - 1];
      if (lastLine?.words.size !== 1) continue;
      const [wordOffset, last] = [...lastLine.words.entries()][0]!;
      // A word split across visual lines is not a separate final orphan word.
      if (lines.slice(0, -1).some((line) => line.words.has(wordOffset))) continue;
      const word = last.value;
      if (ATOMIC.test(word)) continue;
      // A chip is not prose. A lone token whose glyphs live inside a padded,
      // boxed inline element (a <code> chip, pill, or badge) is a UI control:
      // it cannot be rebalanced by rewording, tag rows legitimately wrap to a
      // single chip, and its shifted glyph box also buckets as a phantom
      // "line" when it sits mid-line beside normal text. Walk the word's
      // inline ancestry (tag-based, since flex/grid parents blockify computed
      // display) and skip the finding when a chip hosts it.
      const chipHosted = (() => {
        for (let e = last.node.parentElement; e && INLINE.has(e.tagName); e = e.parentElement) {
          const cs = getComputedStyle(e);
          const padX =
            (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
          const boxed =
            (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") ||
            (Number.parseFloat(cs.borderTopWidth) || 0) > 0;
          if (padX > 0 && boxed) return true;
          if (e === el) break;
        }
        return false;
      })();
      if (chipHosted) continue;

      runts.push({
        block: label(el),
        word,
        snippet: text.replace(/\s+/g, " ").trim().slice(0, 80),
        rect: {
          x: Math.round(last.rect.x + sx),
          y: Math.round(last.rect.y + sy),
          width: Math.round(last.rect.width),
          height: Math.round(last.rect.height),
        },
        lines: lines.length,
      });
      if (runts.length >= RUNT_CAP) {
        truncated = true;
        break;
      }
    }

    return {
      scope,
      found: true,
      outcome: runts.length > 0 ? "fail" : truncated ? "unknown" : "pass",
      scannedBlocks: scanned,
      truncated,
      runts,
    };
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
