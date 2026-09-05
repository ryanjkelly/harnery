import { afterEach, expect, test } from "bun:test";
import { buildFileSearchPrompt } from "./file-search-prompt";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("folder search hits navigate to Browse while files keep the file viewer", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      matches: [
        { relPath: "docs/reviews", kind: "dir" },
        { relPath: "docs/reviews/readme.md", kind: "file" },
      ],
      total: 2,
      truncated: false,
    })) as unknown as typeof fetch;
  const opened: string[] = [];
  const prompt = buildFileSearchPrompt((path) => opened.push(path));
  const items = await prompt.suggestAsync!("reviews");
  expect(items[0].recent?.href).toBe("/browse?dir=docs%2Freviews");
  expect(items[1].recent?.href).toBe("/files?path=docs%2Freviews%2Freadme.md");
  items[1].onSelect?.();
  expect(opened).toEqual(["docs/reviews/readme.md"]);
});

test("an incomplete index cannot masquerade as a complete empty search", async () => {
  globalThis.fetch = (async () =>
    Response.json({
      matches: [],
      total: 0,
      truncated: true,
      indexing: true,
    })) as unknown as typeof fetch;
  const prompt = buildFileSearchPrompt(() => {});
  const items = await prompt.suggestAsync!("new output");
  expect(items).toHaveLength(1);
  expect(items[0].label).toBe("Search index is updating");
});
