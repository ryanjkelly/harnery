import { describe, expect, test } from "bun:test";
import { isDeclaredMonolith } from "../../src/lib/docs-lint.ts";

const frontmatter = ["---", ...Array.from({ length: 13 }, (_, i) => `key${i}: value`), "---"].join("\n");
const banner = "<!-- INTENTIONAL-MONOLITH: one cohesive runbook. Do not split. -->";

describe("isDeclaredMonolith", () => {
  test("finds a banner at the top of a file without frontmatter", () => {
    expect(isDeclaredMonolith(`${banner}\n# Title\n`)).toBe(true);
  });

  test("finds a banner right after frontmatter longer than 10 lines", () => {
    expect(isDeclaredMonolith(`${frontmatter}\n${banner}\n\n# Title\n`)).toBe(true);
  });

  test("ignores a banner buried deep in the body", () => {
    const filler = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
    expect(isDeclaredMonolith(`${frontmatter}\n# Title\n${filler}\n${banner}\n`)).toBe(false);
  });

  test("reports no banner when there is none", () => {
    expect(isDeclaredMonolith(`${frontmatter}\n# Title\n`)).toBe(false);
  });
});
