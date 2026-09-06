import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { retainPageReviewSourceIdentity } from "./page-review-source.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("receipt preserves the exact existing digest bytes and both retry inputs privately", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-source-"));
  dirs.push(dir);
  const prefix = join(dir, "capture");
  const input = {
    nodes: [{ path: "body/0", tag: "p", attrs: "data-instance=one", text: "résumé 🌿" }],
    stylesheets: [
      { key: "inline:0", digest: "a" },
      { key: "inline:1", digest: "b" },
    ],
    dom: '<html><head><script nonce="first">const value="private";</script></head><body>Résumé 🌿</body></html>',
  };
  const expectedBytes = JSON.stringify({
    nodes: input.nodes,
    stylesheets: input.stylesheets,
    dom: input.dom,
  });
  const first = retainPageReviewSourceIdentity(input, prefix);
  const saved = readFileSync(first.evidence!.path);
  expect(saved.toString("utf8")).toBe(expectedBytes);
  expect(createHash("sha256").update(saved).digest("hex")).toBe(first.digest);
  expect(first.digest).toBe(createHash("sha256").update(expectedBytes).digest("hex"));
  expect(first.evidence!.sha256).toBe(first.digest);
  expect(first.evidence!.bytes).toBe(saved.length);
  expect(JSON.stringify(first)).not.toContain("private");
  if (process.platform !== "win32") {
    expect(statSync(dirname(first.evidence!.path)).mode & 0o777).toBe(0o700);
    expect(statSync(first.evidence!.path).mode & 0o777).toBe(0o600);
  }
  const changed = retainPageReviewSourceIdentity(
    { ...input, dom: input.dom.replace("first", "second") },
    prefix,
  );
  expect(changed.digest).not.toBe(first.digest);
  expect(readFileSync(first.evidence!.path, "utf8")).toBe(expectedBytes);
  expect(JSON.parse(readFileSync(changed.evidence!.path, "utf8")).dom).toContain('nonce="second"');
  expect(
    retainPageReviewSourceIdentity({ ...input, stylesheets: [...input.stylesheets].reverse() })
      .digest,
  ).not.toBe(first.digest);
});

test("a print-only identity has no artifact side effects or inline source", () => {
  const dir = mkdtempSync(join(tmpdir(), "review-source-print-"));
  dirs.push(dir);
  const result = retainPageReviewSourceIdentity({
    nodes: [],
    stylesheets: [],
    dom: "private content",
  });
  expect(result.evidence).toBeUndefined();
  expect(Object.keys(result)).toEqual(["digest"]);
  expect(readdirSync(dir)).toEqual([]);
});
