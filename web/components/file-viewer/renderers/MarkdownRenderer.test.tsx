import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileText } from "@/lib/file-viewer/types";
import MarkdownRenderer from "./MarkdownRenderer";

function renderMarkdown(content: string): string {
  const file: FileText = {
    relPath: "docs/guide.md",
    size: content.length,
    mtime: "2026-10-18T00:00:00.000Z",
    mime: "text/markdown",
    category: "markdown",
    content,
    lines: content.split("\n").length,
    truncated: false,
  };
  return renderToStaticMarkup(<MarkdownRenderer file={file} />);
}

test("local links before their headings resolve to safe heading targets", () => {
  const html = renderMarkdown("[Setup](#setup-instructions)\n\n## Setup instructions");
  expect(html).toContain('href="#user-content-setup-instructions"');
  expect(html).toContain('id="user-content-setup-instructions"');
});

test("heading targets use rendered inline text and image alternatives", () => {
  const html = renderMarkdown(
    "[API](#api-agentsentriesid-icon)\n\n## **API** `agents.entries.<id>` ![icon](icon.png)",
  );
  expect(html).toContain('href="#user-content-api-agentsentriesid-icon"');
  expect(html).toContain('id="user-content-api-agentsentriesid-icon"');
  expect(html).toContain("<strong>API</strong>");
  expect(html).toMatch(/<code\b[^>]*>agents\.entries\.&lt;id&gt;<\/code>/);
});

test("duplicate heading suffixes cannot collide and reset for each document", () => {
  const content =
    "[First](#foo) [Second](#foo-1) [Third](#foo-1-1)\n\n# Foo\n\n## Foo\n\n### Foo-1";
  const html = renderMarkdown(content);
  const ids = [...html.matchAll(/<h[1-6]\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(ids).toEqual(["user-content-foo", "user-content-foo-1", "user-content-foo-1-1"]);
  for (const id of ids) expect(html).toContain(`href="#${id}"`);
  expect(renderMarkdown(content)).toBe(html);
});

test("Unicode fragments retain punctuation spacing and support encoded links", () => {
  const html = renderMarkdown("[Read](#r%C3%A9sum%C3%A9--%E5%AE%89%E8%A3%85)\n\n## Résumé — 安装");
  expect(html).toContain('id="user-content-résumé--安装"');
  expect(html).toContain('href="#user-content-r%C3%A9sum%C3%A9--%E5%AE%89%E8%A3%85"');
});

test("existing sanitized footnote targets survive heading-name collisions", () => {
  const html = renderMarkdown(
    "[Heading](#footnote-label)\n\n# Footnote label\n\nText with a note.[^note]\n\n[^note]: Note text.",
  );
  expect(html).toContain('<h2 class="sr-only" id="user-content-footnote-label">');
  expect(html).toContain('aria-describedby="user-content-footnote-label"');
  expect(html).toContain('<h1 id="user-content-footnote-label-1">');
  expect(html).toContain('href="#user-content-footnote-label-1"');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
});

test("unmatched, malformed, and external fragments are left unchanged", () => {
  const html = renderMarkdown(
    "[Missing](#missing) [Malformed](#%E0%A4%A) [External](https://example.com/guide#location)\n\n# Location",
  );
  expect(html).toContain('href="#missing"');
  expect(html).toContain('href="#%E0%A4%25A"');
  expect(html).toContain('href="https://example.com/guide#location"');
});

test("heading IDs preserve clobber protection and raw HTML stays inert", () => {
  const html = renderMarkdown(
    "[Location](#location) [Unsafe](javascript:alert%281%29)\n\n# Location\n\n<script>alert(1)</script>",
  );
  expect(html).toContain('id="user-content-location"');
  expect(html).not.toContain('id="location"');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
});

test("routes relative Markdown images through the source document directory", () => {
  const file: FileText = {
    relPath: ".harnery/artifacts/run-1/review/review.md",
    size: 64,
    mtime: "2026-08-31T00:00:00.000Z",
    mime: "text/markdown",
    category: "markdown",
    content:
      "![chapter evidence](sheets/chapter.png)\n\n![remote evidence](https://example.com/frame.png)",
    lines: 3,
    truncated: false,
  };

  const html = renderToStaticMarkup(<MarkdownRenderer file={file} />);
  expect(html).toContain(
    'src="/api/file?path=.harnery%2Fartifacts%2Frun-1%2Freview%2Fsheets%2Fchapter.png"',
  );
  expect(html).toContain('src="https://example.com/frame.png"');
});
