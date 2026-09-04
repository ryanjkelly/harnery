import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorizedJson } from "@/components/log-table/ColorizedJson";
import type { FileText } from "@/lib/file-viewer/types";
import JsonRenderer from "./JsonRenderer";
import MarkdownRenderer from "./MarkdownRenderer";
import TextRenderer from "./TextRenderer";

function file(category: FileText["category"], relPath: string, content: string): FileText {
  return {
    relPath,
    size: content.length,
    mtime: "2026-09-04T00:00:00.000Z",
    mime: "text/plain; charset=utf-8",
    category,
    content,
    lines: 1,
    truncated: false,
  };
}

test("plain text, Markdown, and formatted JSON expose the shared Wrap control", () => {
  const rendered = [
    renderToStaticMarkup(<TextRenderer file={file("text", "notes.txt", "long line")} />),
    renderToStaticMarkup(<MarkdownRenderer file={file("markdown", "notes.md", "long line")} />),
    renderToStaticMarkup(<JsonRenderer file={file("json", "data.json", '{"value":"long"}')} />),
  ];
  for (const html of rendered) {
    expect(html).toContain("Wrap</button>");
    expect(html).toContain('aria-pressed="true"');
  }
});

test("formatted JSON can disable soft wrapping", () => {
  const html = renderToStaticMarkup(<ColorizedJson value={{ value: "long" }} wrap={false} />);
  expect(html).toContain("whitespace-pre");
  expect(html).not.toContain("whitespace-pre-wrap");
});
