import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileText } from "@/lib/file-viewer/types";
import HtmlRenderer from "./HtmlRenderer";

const file: FileText = {
  relPath: "reports/saved page.html",
  size: 1_000_000,
  mtime: "2026-09-05T00:00:00.000Z",
  mime: "text/html",
  category: "html",
  content: "<head><style>/* truncated stylesheet */",
  lines: 5_000,
  truncated: true,
};

test("HTML preview loads the complete sandboxed document, not the source excerpt", () => {
  const html = renderToStaticMarkup(<HtmlRenderer file={file} initialMode="preview" />);
  expect(html).toContain('src="/files/render/reports/saved%20page.html"');
  expect(html).toContain('sandbox=""');
  expect(html).not.toContain("Showing first");
  expect(html).not.toContain("allow-scripts");
  expect(html).not.toContain("allow-same-origin");
});

test("HTML source retains its truncation notice", () => {
  const html = renderToStaticMarkup(<HtmlRenderer file={file} initialMode="source" />);
  expect(html).toContain("Showing first");
  expect(html).not.toContain("<iframe");
});
