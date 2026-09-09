import { expect, test } from "bun:test";
import {
  encodedRepoPath,
  encodeLinkSafeComponent,
  localFilesOriginUrl,
  localFileViewerUrl,
} from "./local-file-url.ts";

// These URLs are pasted into Markdown for a human to click. A raw ")" ends a
// [text](url) destination early, and the angle-bracket form that would have
// tolerated it renders as unclickable styled text in some renderers.
test("encodes the characters that would break a bare Markdown destination", () => {
  expect(encodeLinkSafeComponent("take (2).mp4")).toBe("take%20%282%29.mp4");
  expect(encodeLinkSafeComponent("a/b")).toBe("a%2Fb");
  expect(encodeLinkSafeComponent("plain.txt")).toBe("plain.txt");
});

test("keeps generated file URLs free of unbalanced Markdown delimiters", () => {
  const viewer = localFileViewerUrl("docs/take (2).md", 4276);
  const origin = localFilesOriginUrl("docs/take (2).md", 4276);
  for (const url of [viewer, origin]) {
    expect(url).not.toContain("(");
    expect(url).not.toContain(")");
    expect(url).not.toContain(" ");
  }
  expect(viewer).toBe("http://localhost:4276/files?path=docs%2Ftake%20%282%29.md");
});

test("encodes each repo-path segment but keeps the slashes that resolve the URL", () => {
  expect(encodedRepoPath("/docs/a b/take (2).md")).toBe("docs/a%20b/take%20%282%29.md");
});
