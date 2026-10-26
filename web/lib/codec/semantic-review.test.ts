import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { runSemanticReviewCommand } from "./semantic-review";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function commandRoot(source: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "codec-review-command-"));
  roots.push(root);
  mkdirSync(path.join(root, "bin"));
  writeFileSync(path.join(root, "bin/harn"), `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return root;
}

test("semantic review commands preserve argument boundaries and JSON output", async () => {
  const root = commandRoot("console.log(JSON.stringify(process.argv.slice(2)))");
  const result = await runSemanticReviewCommand(["two words", "literal;argument"], { root });
  expect(result.ok).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(["two words", "literal;argument"]);
});

test("semantic review commands fail closed on a nonzero exit", async () => {
  const root = commandRoot('console.error("invalid submission"); process.exitCode = 2;');
  const result = await runSemanticReviewCommand([], { root });
  expect(result.ok).toBe(false);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("invalid submission");
});

test("semantic review commands terminate a hung child", async () => {
  const root = commandRoot('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);');
  const result = await runSemanticReviewCommand([], { root, timeoutMs: 100 });
  expect(result.ok).toBe(false);
  expect(result.stderr).toContain("timed out");
});

test("semantic review commands bound subprocess output", async () => {
  const root = commandRoot('process.stdout.write("x".repeat(16_384));');
  const result = await runSemanticReviewCommand([], { root, maxBuffer: 1024 });
  expect(result.ok).toBe(false);
  expect(result.stdout.length).toBeLessThanOrEqual(1024);
  expect(result.stderr).toContain("maxBuffer");
});
