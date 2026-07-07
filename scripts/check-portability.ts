#!/usr/bin/env bun
/**
 * Portability guard — fails when host-specific tokens leak into committable
 * source. harnery is published to npm and cloned by arbitrary hosts, so nothing
 * naming a specific consumer (its bin, business, submodules, data warehouse,
 * skills) may land in `src/`, `web/`, `docs/`, `schemas/`, `tests/`, `bin/`, or
 * `examples/`. This is the automated backstop for the "Portability is the prime
 * constraint" rule in AGENTS.md/CLAUDE.md.
 *
 * The leak that motivated this: the strangler-fig extraction from the original
 * host monorepo copied over the host bin name ("bp"), its submodule paths
 * (bp-dbt/…), its dbt marts (fct_orders), and its decision skill (/decide) as
 * example data, and a later feature added more. See the history for the sweep
 * that removed them.
 *
 * Escape hatch: put `portability-allow: <reason>` on the same line to whitelist a
 * genuine, non-host use (rare — prefer rewording to a neutral token). Keep it
 * honest: it's a per-line waiver, not a mute button.
 *
 * Run:  bun run scripts/check-portability.ts   (exits 1 on any violation)
 * Test: tests/unit/portability.test.ts asserts zero violations in CI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

/** Host-specific token patterns. Curated to be high-signal — a hit is almost
 *  always a real leak, not generic English. Add a pattern when a new host term
 *  slips in; keep each one tight enough that the escape hatch stays rare. */
const DENY: { re: RegExp; label: string }[] = [
  { re: /\bbarton\b/i, label: "host business name ('barton')" },
  { re: /\bbp\b/, label: "host bin abbreviation ('bp')" },
  { re: /\bBP\b/, label: "host abbreviation ('BP')" },
  { re: /\bbp[-_][a-z]/i, label: "host repo/dataset ('bp-*' / 'bp_*')" },
  { re: /\b(BARTN|GARDN)\b/, label: "host merchant prefix" },
  { re: /industrial-fx/i, label: "host GCP project id" },
  { re: /\bfct_[a-z]/i, label: "host dbt mart name ('fct_*')" },
  { re: /\/decide\b/, label: "host skill name ('/decide')" },
  { re: /\b(ultracart|clickbank|maropost|openclaw)\b/i, label: "host vendor/agent name" },
];

const SCAN_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".md", ".mdx", ".json", ".jsonc", ".yaml", ".yml", ".sh", ".css", ".astro",
]);
const SCAN_ROOTS = ["src", "web", "docs", "schemas", "tests", "bin", "examples", ".changeset"];
const SKIP_DIR = new Set([
  "node_modules", "dist", ".git", "coverage", ".next", "build", "out", ".astro", ".turbo", ".vercel",
]);
/** The guard + its test embed the patterns/examples by nature; never scan them. */
const SELF = new Set(["scripts/check-portability.ts", "tests/unit/portability.test.ts"]);
const ALLOW = "portability-allow";

export interface Violation {
  file: string;
  line: number;
  label: string;
  text: string;
}

function walk(dir: string, root: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // missing scan root is fine (standalone layouts differ)
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const abs = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, root, out);
    } else if (SCAN_EXT.has(extname(name))) {
      out.push(abs);
    }
  }
}

/** Scan committable source under `root` for host-specific tokens. */
export function scanPortability(root: string): Violation[] {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) walk(join(root, r), root, files);

  const violations: Violation[] = [];
  for (const abs of files) {
    const rel = relative(root, abs).split("\\").join("/");
    if (SELF.has(rel)) continue;
    let content: string;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes(ALLOW)) continue;
      for (const { re, label } of DENY) {
        if (re.test(line)) {
          violations.push({ file: rel, line: i + 1, label, text: line.trim().slice(0, 120) });
        }
      }
    }
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const violations = scanPortability(root);
  if (violations.length === 0) {
    console.log("portability: clean — no host-specific tokens in committable source.");
    process.exit(0);
  }
  console.error(`portability: ${violations.length} host-specific token(s) found:\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  [${v.label}]`);
    console.error(`    ${v.text}`);
  }
  console.error(
    `\nharnery ships to npm and is cloned by arbitrary hosts — nothing host-specific may land in committable source.`,
  );
  console.error(
    `Reword to a neutral token (e.g. "acme"), read the bin name via resolveBinName(), or (rarely) add \`${ALLOW}: <reason>\` on the line.`,
  );
  process.exit(1);
}
