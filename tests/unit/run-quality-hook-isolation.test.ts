import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

describe("run-quality hook isolation", () => {
  test("the event drain does not invoke the evaluator before the latency gate", () => {
    const source = readFileSync(
      join(resolve(import.meta.dir, "../.."), "src", "core", "hooks", "cli.ts"),
      "utf8",
    );
    expect(source).not.toContain("evaluateRunQualityIfDue");
    expect(source).not.toContain('from "../guard');
    expect(source).toContain('from "./events/input-hash.ts"');
  });
});
