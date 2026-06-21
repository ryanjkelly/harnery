/**
 * Tests for `src/lib/readability/client.ts` (htmlToMarkdown).
 *
 * Covers:
 *   - Base markdown conversion (headings, lists, code, links, emphasis)
 *   - GFM tables (the reason this file exists: Turndown's default rules
 *     flatten <table> into a vertical text dump; we use turndown-plugin-gfm)
 *   - GFM strikethrough
 *   - Selector-bypass mode (used when Readability misses the main article)
 *   - --raw mode
 *   - Readability integration (full-page → article extraction)
 *   - Input validation + truncation
 *
 * htmlToMarkdown is async (jsdom/readability/turndown load lazily so they stay
 * out of CLI startup), so every call here is awaited and the throw-path tests
 * assert via `.rejects`.
 */

import { describe, expect, test } from "bun:test";
import { htmlToMarkdown } from "../src/lib/readability/client.ts";

// Tests that target the Turndown layer use `selector` to bypass Readability,
// which is opinionated about what counts as an "article" and would otherwise
// reject these minimal payloads.
const md = async (html: string, selector = "div"): Promise<string> =>
  (await htmlToMarkdown(`<div>${html}</div>`, { selector })).output;

describe("htmlToMarkdown: base conversion", () => {
  test("headings render as ATX style", async () => {
    expect(await md("<h1>One</h1>")).toContain("# One");
    expect(await md("<h2>Two</h2>")).toContain("## Two");
    expect(await md("<h3>Three</h3>")).toContain("### Three");
  });

  test("bullet lists use '-' marker", async () => {
    expect(await md("<ul><li>one</li><li>two</li></ul>")).toMatch(/-\s+one[\s\S]*-\s+two/);
  });

  test("code blocks render as fenced", async () => {
    const out = await md("<pre><code>console.log(1)</code></pre>");
    expect(out).toMatch(/```[\s\S]*console\.log\(1\)[\s\S]*```/);
  });

  test("links use [text](href) form", async () => {
    expect(await md(`<a href="https://example.com">click</a>`)).toContain(
      "[click](https://example.com)",
    );
  });

  test("inline emphasis is preserved", async () => {
    expect(await md("<em>x</em>")).toContain("_x_");
    expect(await md("<strong>x</strong>")).toContain("**x**");
  });

  test("scripts/styles/iframes/noscript are stripped", async () => {
    const out = await md(
      `<script>alert(1)</script><style>p{color:red}</style>` +
        `<iframe src="x"></iframe><noscript>fallback</noscript><p>keep</p>`,
    );
    expect(out).toContain("keep");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("iframe");
    expect(out).not.toContain("fallback");
  });
});

describe("htmlToMarkdown: GFM tables", () => {
  test("table with thead+tbody becomes a markdown table", async () => {
    const out = await md(
      "<table><thead><tr><th>Name</th><th>Type</th></tr></thead>" +
        "<tbody><tr><td>foo</td><td>string</td></tr></tbody></table>",
    );
    expect(out).toContain("| Name | Type |");
    expect(out).toContain("| --- | --- |");
    expect(out).toContain("| foo | string |");
  });

  test("table with implicit thead (first row is <th>) still converts", async () => {
    const out = await md(
      "<table><tr><th>Name</th><th>Type</th></tr>" +
        "<tr><td>foo</td><td>string</td></tr></table>",
    );
    expect(out).toContain("| Name | Type |");
    expect(out).toContain("| foo | string |");
  });

  test("inline formatting inside cells is preserved", async () => {
    const out = await md(
      "<table><thead><tr><th>K</th><th>V</th></tr></thead>" +
        "<tbody><tr><td><em>foo</em></td><td><strong>bar</strong></td></tr></tbody></table>",
    );
    expect(out).toContain("| _foo_ | **bar** |");
  });

  test("empty cells preserve row shape", async () => {
    const out = await md(
      "<table><thead><tr><th>A</th><th>B</th></tr></thead>" +
        "<tbody><tr><td>x</td><td></td></tr></tbody></table>",
    );
    // Pipe, whitespace, x, whitespace, pipe, whitespace, pipe (empty cell)
    expect(out).toMatch(/\|\s*x\s*\|\s*\|/);
  });

  test("three-column table renders all columns", async () => {
    const out = await md(
      "<table><thead><tr><th>a</th><th>b</th><th>c</th></tr></thead>" +
        "<tbody><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>",
    );
    expect(out).toContain("| a | b | c |");
    expect(out).toContain("| --- | --- | --- |");
    expect(out).toContain("| 1 | 2 | 3 |");
  });

  test("regression: cells do NOT flatten into a vertical text dump", async () => {
    // Pre-fix, default Turndown would emit each cell as a free-floating line:
    //   "Name\nType\nfoo\nstring\n"
    // Lock against that regression by asserting the markdown contains pipes.
    const out = await md(
      "<table><thead><tr><th>Name</th><th>Type</th></tr></thead>" +
        "<tbody><tr><td>foo</td><td>string</td></tr></tbody></table>",
    );
    expect(out).toContain("|");
    expect(out.split("\n").filter((l) => l.trim() === "Name").length).toBe(0);
  });
});

describe("htmlToMarkdown: GFM strikethrough", () => {
  test("<del> renders as ~~text~~", async () => {
    expect(await md("<del>gone</del>")).toContain("~~gone~~");
  });

  test("<s> renders as ~~text~~", async () => {
    expect(await md("<s>gone</s>")).toContain("~~gone~~");
  });

  test("deprecated <strike> renders as ~~text~~", async () => {
    expect(await md("<strike>gone</strike>")).toContain("~~gone~~");
  });
});

describe("htmlToMarkdown: selector mode", () => {
  test("extracts content matching selector and discards the rest", async () => {
    const html = `<div><h1>Skip</h1><article><p>Keep</p></article></div>`;
    const r = await htmlToMarkdown(html, { selector: "article" });
    expect(r.output).toContain("Keep");
    expect(r.output).not.toContain("Skip");
  });

  test("title is null when bypassing Readability", async () => {
    const r = await htmlToMarkdown("<div><p>x</p></div>", { selector: "div" });
    expect(r.title).toBeNull();
  });

  test("throws when selector matches nothing", async () => {
    expect(htmlToMarkdown("<p>x</p>", { selector: ".nope" })).rejects.toThrow(/Selector/);
  });
});

describe("htmlToMarkdown: raw mode", () => {
  test("returns cleaned HTML instead of markdown", async () => {
    const r = await htmlToMarkdown("<div><h1>Hi</h1></div>", { selector: "div", raw: true });
    expect(r.output).toContain("<h1>Hi</h1>");
    expect(r.output).not.toContain("# Hi");
  });
});

describe("htmlToMarkdown: input validation", () => {
  test("throws on empty input", async () => {
    expect(htmlToMarkdown("")).rejects.toThrow(/Empty/);
  });

  test("throws on whitespace-only input", async () => {
    expect(htmlToMarkdown("   \n\t  ")).rejects.toThrow(/Empty/);
  });
});

describe("htmlToMarkdown: Readability integration", () => {
  test("extracts article body + title, skips nav/footer chrome", async () => {
    // Readability scores elements by paragraph density. Long-ish paragraph
    // text keeps this test deterministic across Readability version bumps.
    const html = `<!doctype html>
<html><head><title>Article: the post</title></head><body>
<nav>nav stuff that should be excluded</nav>
<article>
  <h1>The post</h1>
  <p>This is the first paragraph of the article body. It is intentionally
  long enough that Readability scores it as the main content. The scoring
  algorithm rewards paragraph density, so we keep this section clearly
  above the noise threshold from nav and footer.</p>
  <p>A second supporting paragraph in the same article so the scoring
  consistently favors this section over nav and footer chrome.</p>
  <table><thead><tr><th>A</th><th>B</th></tr></thead>
  <tbody><tr><td>1</td><td>2</td></tr></tbody></table>
</article>
<footer>footer noise that should be excluded</footer>
</body></html>`;
    const r = await htmlToMarkdown(html);
    // Readability extracts the title separately and strips it from the
    // body content to avoid duplication, so we assert on `title` here, not
    // on `output`.
    expect(r.title).toContain("the post");
    expect(r.output).toContain("| A | B |");
    expect(r.output).toContain("| 1 | 2 |");
    expect(r.output).not.toContain("nav stuff");
    expect(r.output).not.toContain("footer noise");
  });

  test("throws if Readability finds no article", async () => {
    // Tiny HTML with no recognizable article body.
    expect(htmlToMarkdown("<html><body></body></html>")).rejects.toThrow();
  });
});

describe("htmlToMarkdown: pre-Turndown DOM preprocessing", () => {
  test("<br> inside <td> becomes a space, not a newline", async () => {
    // Without the preprocess, turndown-plugin-gfm emits `\n` for <br>
    // and the resulting markdown table row contains a raw newline that
    // strict CommonMark renderers reject. The preprocess replaces <br>
    // inside cells with a space.
    const out = await md(
      "<table><thead><tr><th>Key</th><th>Val</th></tr></thead>" +
        "<tbody><tr><td>Possible values are ALL or EXPIRING<br>Default: ALL</td><td>x</td></tr></tbody></table>",
    );
    // The single-row data line should be a single line (no embedded \n
    // before the trailing pipe), and should contain both halves of the
    // original cell content joined by space.
    expect(out).toMatch(/\| Possible values are ALL or EXPIRING\s+Default: ALL \| x \|/);
    // No literal newline inside the cell row; count of pipes per data
    // row stays at the column count + 1.
    const dataRows = out
      .split("\n")
      .filter((l) => /^\|/.test(l) && !/^\|\s*---/.test(l) && !/Key.*Val/.test(l));
    for (const row of dataRows) {
      expect(row.split("|").length).toBe(4); // empty + 2 cells + empty
    }
  });

  test("<br> inside <th> becomes a space", async () => {
    const out = await md(
      "<table><thead><tr><th>Name<br>(string)</th><th>V</th></tr></thead>" +
        "<tbody><tr><td>a</td><td>b</td></tr></tbody></table>",
    );
    expect(out).toMatch(/\| Name\s+\(string\) \| V \|/);
  });

  test("<br> OUTSIDE table cells still produces a line break", async () => {
    // Make sure we only flattened <br>s inside <td>/<th>, not all <br>s.
    const out = await md("<p>line one<br>line two</p>");
    // Turndown emits "  \n" for a paragraph <br>.
    expect(out).toMatch(/line one\s*\n\s*line two/);
  });

  test("<pre> with nested element tokens collapses to textContent", async () => {
    // Mimics Namecheap-style syntax-highlighted code: each token wrapped
    // in a <span>. Without the preprocess, turndown escapes the angle
    // brackets and emits very noisy markdown.
    const out = await md(
      `<pre><span>&lt;</span><span>ApiResponse</span> <span>Status</span><span>="OK"</span><span>&gt;</span></pre>`,
    );
    // Should land in a fenced or indented code block with raw angle
    // brackets (not escaped `\<` / `\>`).
    expect(out).toContain(`<ApiResponse Status="OK">`);
    expect(out).not.toContain("\\<");
    expect(out).not.toContain("\\>");
  });

  test("<pre><code> (canonical code block) is left intact", async () => {
    // The element-children check intentionally targets <pre> with FAKE
    // structural content (tokenizing spans) but leaves real <pre><code>
    // wrappers alone; Turndown's fenced-code-block rule expects the
    // <code> child.
    const out = await md("<pre><code>console.log(1)</code></pre>");
    expect(out).toMatch(/```[\s\S]*console\.log\(1\)[\s\S]*```/);
  });

  test("plain-text <pre> (no element children) passes through unchanged", async () => {
    const out = await md("<pre>raw text only</pre>");
    expect(out).toContain("raw text only");
  });
});

describe("htmlToMarkdown: truncation", () => {
  test("output is capped at maxChars with a truncation marker", async () => {
    const big = `<p>${"x".repeat(5000)}</p>`;
    const r = await htmlToMarkdown(big, { selector: "p", maxChars: 100 });
    expect(r.output.length).toBeLessThan(250);
    expect(r.output).toContain("truncated from");
  });

  test("maxChars: 0 disables truncation", async () => {
    const big = `<p>${"x".repeat(5000)}</p>`;
    const r = await htmlToMarkdown(big, { selector: "p", maxChars: 0 });
    expect(r.output.length).toBeGreaterThan(4000);
    expect(r.output).not.toContain("truncated from");
  });
});
