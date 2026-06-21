/// <reference path="./turndown-plugin-gfm.d.ts" />
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { tables } from "turndown-plugin-gfm";

/**
 * HTML → clean markdown via Readability (main-content extraction) +
 * Turndown (HTML → markdown).
 *
 * The library backing the `read` command.
 */

export interface ReadabilityOptions {
  /** Base URL for resolving relative links. Default `http://local/`. */
  url?: string;
  /** CSS selector for content. Bypasses Readability when set. */
  selector?: string;
  /** Truncate output to N chars (0 = no limit). Default 100000. */
  maxChars?: number;
  /** Return cleaned HTML instead of markdown (debugging). */
  raw?: boolean;
}

export interface ReadabilityResult {
  /** Final output: markdown or cleaned HTML when `raw: true`. */
  output: string;
  /** Pre-truncation length so callers can report what was dropped. */
  rawLength: number;
  /** Article title from Readability (`null` when --selector is used). */
  title: string | null;
}

const DEFAULT_MAX_CHARS = 100_000;

/**
 * Convert raw HTML to clean markdown.
 *
 * Throws if input is empty, the selector matches nothing, or Readability
 * fails to find a main article (caller should retry with `selector`).
 */
export function htmlToMarkdown(html: string, opts: ReadabilityOptions = {}): ReadabilityResult {
  if (!html.trim()) {
    throw new Error("Empty HTML input");
  }

  const dom = new JSDOM(html, { url: opts.url ?? "http://local/" });
  const doc = dom.window.document;
  preprocessDom(doc);

  let contentHtml: string;
  let title: string | null = null;

  if (opts.selector) {
    const el = doc.querySelector(opts.selector);
    if (!el) {
      throw new Error(`Selector "${opts.selector}" matched nothing`);
    }
    contentHtml = el.outerHTML;
  } else {
    const article = new Readability(doc).parse();
    if (!article) {
      throw new Error(
        "Readability found no main content. Try a CSS selector via the `selector` option.",
      );
    }
    contentHtml = article.content ?? "";
    title = article.title ?? null;
  }

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  if (opts.raw) {
    const clean = postprocess(contentHtml, maxChars);
    return { output: clean, rawLength: contentHtml.length, title };
  }

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.remove(["script", "style", "iframe", "noscript"]);
  turndown.use(tables);
  // GFM-spec strikethrough is `~~text~~`. turndown-plugin-gfm's bundled
  // strikethrough emits single-tilde `~text~` for pre-spec compatibility,
  // which most modern renderers (GitHub, VS Code, CommonMark with the
  // strikethrough extension) don't recognize. Register our own.
  turndown.addRule("strikethrough-gfm", {
    filter: (node) =>
      node.nodeName === "DEL" || node.nodeName === "S" || node.nodeName === "STRIKE",
    replacement: (content) => `~~${content}~~`,
  });
  const markdown = turndown.turndown(contentHtml);
  const out = postprocess(markdown, maxChars);
  return { output: out, rawLength: markdown.length, title };
}

/**
 * Two pre-Turndown / pre-Readability HTML fixups that target the
 * highest-impact noise patterns we hit in real-world scrapes:
 *
 *   1. `<br>` inside table cells (`<th>`/`<td>`) → replace with a space.
 *      turndown-plugin-gfm emits literal `\n` for `<br>` and that breaks
 *      strict CommonMark renderers when it lands inside a markdown table
 *      cell. GitHub tolerates it but the resulting markdown is uglier.
 *
 *   2. `<pre>` containing element children (e.g. syntax-highlighting
 *      `<span>`-per-token) → collapse to plain textContent. Turndown's
 *      bare-`<pre>` path treats element-rich `<pre>` blocks as inline
 *      text and escapes `<`/`>`/`*`/etc, producing very noisy markdown
 *      that no longer round-trips as code. The textContent of any
 *      well-formed token-highlighted block IS the original code.
 *
 * Applied AFTER JSDOM parse but BEFORE Readability / selector extraction
 * so both paths benefit. Both passes are no-ops on HTML that doesn't
 * exhibit the pattern, so the cost on simple inputs is one DOM walk.
 */
function preprocessDom(doc: Document): void {
  // (1) Flatten <br> inside table cells.
  for (const br of Array.from(doc.querySelectorAll("td br, th br"))) {
    br.replaceWith(doc.createTextNode(" "));
  }
  // (2) Collapse element-rich <pre> blocks to <pre><code>textContent</code>
  //     so Turndown's fenced-code-block rule applies. Pure-text <pre> and
  //     canonical <pre><code>...</code></pre> wrappers are left alone;
  //     Turndown handles both correctly (the latter even with nested
  //     syntax-highlighting spans inside the <code>, since the rule keys
  //     on textContent). The bug case is element-rich <pre> WITHOUT a
  //     <code> wrapper (per-token <span>s as direct pre children), which
  //     Turndown otherwise treats as inline text and escapes every <, >,
  //     *, etc.
  for (const pre of Array.from(doc.querySelectorAll("pre"))) {
    if (pre.children.length === 0) continue;
    if (pre.children.length === 1 && pre.children[0]?.nodeName === "CODE") continue;
    const text = pre.textContent ?? "";
    while (pre.firstChild) pre.removeChild(pre.firstChild);
    const code = doc.createElement("code");
    code.appendChild(doc.createTextNode(text));
    pre.appendChild(code);
  }
}

function postprocess(text: string, maxChars: number): string {
  let out = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (maxChars > 0 && out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n\n... [truncated from ${text.length} to ${maxChars} chars]`;
  }
  return out;
}
