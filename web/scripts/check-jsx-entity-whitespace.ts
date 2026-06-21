/**
 * Guard against the "round 2once" bug class (bitten three times on 2026-06-10):
 * under this Next/SWC version, a JSX text segment that follows a `{expr}` with
 * a same-line space and contains an HTML entity (`&apos;`, `&lt;`, …) anywhere
 * in the segment loses that leading space at compile time: "round {n} once
 * they&apos;re" renders as "round 2once they're".
 *
 * The fix is always the same: render the dynamic phrase as a single
 * template-literal expression (entities aren't needed inside JS strings), or
 * use the explicit `{" "}` separator idiom. See harnery/AGENTS.md § Web app.
 *
 * Run: `bun scripts/check-jsx-entity-whitespace.ts` (from harnery/web).
 * Exits 1 with file:line findings when the risky shape exists; the parent
 * repo's pre-commit hook runs this when harnery/web .tsx files are staged.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const WEB_ROOT = path.resolve(import.meta.dir, "..");
const SCAN_DIRS = ["app", "components", "lib"];

// `}` + same-line space + text running to the segment's end (next tag or
// expression) that contains an entity. The class deliberately matches
// newlines (the entity may sit on a continuation line of the same segment,
// the steward-seat bug's shape) but excludes `>` so a prop expression
// inside a tag can't bleed through the tag close into following text
// (text-after-ELEMENT is the safe shape). The lookbehind exempts the
// `{" "}` idiom; its explicit space survives regardless.
const RISKY = /(?<!\{" "\})\}[ \t][^<>{}]*&[a-z]{2,8};/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = path.join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === ".next") continue;
      walk(p, out);
    } else if (entry.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

let findings = 0;
for (const dir of SCAN_DIRS) {
  const abs = path.join(WEB_ROOT, dir);
  let files: string[] = [];
  try {
    files = walk(abs);
  } catch {
    continue;
  }
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    for (const m of content.matchAll(RISKY)) {
      const line = content.slice(0, m.index).split("\n").length;
      const snippet = m[0].replace(/\s+/g, " ").slice(0, 80);
      console.error(
        `${path.relative(WEB_ROOT, f)}:${line}: JSX entity-whitespace trap: "${snippet}"`,
      );
      findings++;
    }
  }
}

if (findings > 0) {
  console.error(
    `\n✗ ${findings} risky JSX segment(s): a space after {expr} followed by entity-bearing text gets dropped at compile (the "round 2once" bug).`,
  );
  console.error(
    "  Fix: render the phrase as one template-literal expression, or use the {\" \"} separator. See harnery/AGENTS.md § Web app.",
  );
  process.exit(1);
}
console.log("✓ no JSX entity-whitespace traps");
