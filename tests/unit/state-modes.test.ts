// Project state takes its permission mode from src/core/storage/modes.ts, so private and group
// sharing cannot drift apart. A hard-coded owner-only mode in core code would silently break a
// group-shared project for the second user, so none may be added.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const CORE = join(import.meta.dir, "..", "..", "src", "core");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

test("core code never hard-codes an owner-only mode or check", () => {
  const offenders = walk(CORE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(join("storage", "modes.ts")))
    .flatMap((f) =>
      readFileSync(f, "utf8").split("\n").map((line, i) => ({ f, i, line }))
        .filter(({ line }) => /\b0o(600|700)\b|&\s*0o077\b/.test(line))
        .map(({ f, i, line }) => `${f.slice(CORE.length + 1)}:${i + 1}: ${line.trim()}`),
    );
  expect(offenders).toEqual([]);
});
