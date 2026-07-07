import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPortability } from "../../scripts/check-portability.ts";

// harnery is published to npm and cloned by arbitrary hosts. Host-specific
// tokens (a consumer's bin name, business, submodule paths, data-warehouse
// tables, skills) must never land in committable source. This test is the CI
// backstop for the "Portability is the prime constraint" rule; the same scan
// runs standalone via `bun run scripts/check-portability.ts` and (host-side) in
// the embedding monorepo's pre-commit hook.
describe("portability", () => {
  test("no host-specific tokens in committable source", () => {
    const root = join(import.meta.dir, "..", "..");
    const violations = scanPortability(root);
    if (violations.length > 0) {
      const report = violations.map((v) => `  ${v.file}:${v.line} [${v.label}] ${v.text}`).join("\n");
      throw new Error(`Found ${violations.length} host-specific token(s):\n${report}`);
    }
    expect(violations).toEqual([]);
  });
});
