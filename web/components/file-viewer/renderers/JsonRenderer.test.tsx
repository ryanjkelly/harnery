import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ColorizedJson } from "@/components/log-table/ColorizedJson";
import type { FileText } from "@/lib/file-viewer/types";
import CodeRenderer from "./CodeRenderer";
import JsonRenderer from "./JsonRenderer";

function file(content: string, relPath = "reports/fixture.jsonl"): FileText {
  return {
    relPath,
    size: content.length,
    mtime: "2026-10-18T00:00:00.000Z",
    mime: "application/json",
    category: "json",
    content,
    lines: content.split("\n").length,
    truncated: false,
  };
}

test.each(["jsonl", "ndjson"])("all-invalid %s preserves its original source fallback", (ext) => {
  const source = file("  not-json\n\n  another invalid line  \n", `reports/fixture.${ext}`);
  const html = renderToStaticMarkup(<JsonRenderer file={source} />);
  const fallback = renderToStaticMarkup(<CodeRenderer file={source} wrap={true} />);
  expect(html).toContain(fallback);
  expect(html.match(/Wrap<\/button>/g)).toHaveLength(1);
});

test("a valid row after an invalid row keeps the mixed JSONL view", () => {
  const source = file('not-json\n{"ok":true}');
  const html = renderToStaticMarkup(<JsonRenderer file={source} />);
  expect(html).toContain(renderToStaticMarkup(<ColorizedJson value={{ ok: true }} />));
  expect(html).toContain("not-json");
  expect(html).not.toContain(renderToStaticMarkup(<CodeRenderer file={source} wrap={true} />));
});

test("valid null is a successfully parsed JSONL row", () => {
  const source = file("null");
  const html = renderToStaticMarkup(<JsonRenderer file={source} />);
  expect(html).toContain(renderToStaticMarkup(<ColorizedJson value={null} />));
  expect(html).not.toContain(renderToStaticMarkup(<CodeRenderer file={source} wrap={true} />));
});

test("malformed ordinary JSON retains its source fallback", () => {
  const source = file("  {not-json\n", "reports/fixture.json");
  const html = renderToStaticMarkup(<JsonRenderer file={source} />);
  expect(html).toContain(renderToStaticMarkup(<CodeRenderer file={source} wrap={true} />));
});

test("ordinary JSON keeps intentional encoded-container expansion", () => {
  const source = file(JSON.stringify({ payload: '{"status":"ok"}' }), "reports/fixture.json");
  const html = renderToStaticMarkup(<JsonRenderer file={source} />);
  const expanded = renderToStaticMarkup(<ColorizedJson value={{ payload: { status: "ok" } }} />);
  expect(html).toContain(expanded);
});
