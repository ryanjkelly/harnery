import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanLayering, toolkitExports } from "../../scripts/check-layering.ts";

// The exports map is the tier boundary (ADR 0010): `./lib/*` subpath exports
// are the toolkit tier and must be importable without dragging in the
// coordination core. This test is the CI backstop; the same scan runs
// standalone via `bun run scripts/check-layering.ts`.
describe("layering", () => {
  const root = join(import.meta.dir, "..", "..");

  test("toolkit exports exist to scan", () => {
    // Sanity: if the exports map ever stops carrying ./lib/* entries, this
    // guard would silently pass on nothing. Fail loud instead.
    expect(toolkitExports(root).length).toBeGreaterThan(0);
  });

  test("no toolkit export reaches src/core (directly or transitively)", () => {
    const violations = scanLayering(root);
    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.export_key}\n    ${v.chain.join("\n      -> ")}`)
        .join("\n");
      throw new Error(
        `${violations.length} toolkit export(s) reach the coordination core:\n${report}\n` +
          "Drop the core dependency, or move the export under ./core/*.",
      );
    }
    expect(violations).toEqual([]);
  });
});
