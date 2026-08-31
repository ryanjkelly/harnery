import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileText } from "@/lib/file-viewer/types";
import MarkdownRenderer from "./MarkdownRenderer";

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
