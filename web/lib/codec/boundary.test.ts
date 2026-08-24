/**
 * Dependency-boundary test: the Codec director is read-only by construction.
 *
 * Walks the import graph of every codec module (lib + routes + UI) and fails
 * if any path reaches a Harnery write/control surface: coordination writers,
 * council/decision writers, process launchers, or the CLI. This is the
 * plan's "module layering must prevent imports from coord-writer, process
 * launchers, agent messaging, lifecycle commands, and workflow controls"
 * requirement, enforced.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const WEB_ROOT = path.resolve(import.meta.dir, "../..");

const ENTRYPOINTS = [
  "lib/codec/contracts.ts",
  "lib/codec/sanitize.ts",
  "lib/codec/projector.ts",
  "lib/codec/expression.ts",
  "lib/codec/validator.ts",
  "lib/codec/packs.ts",
  "lib/codec/suggestions.ts",
  "lib/codec/semantic-contract.ts",
  "lib/codec/semantic.ts",
  "lib/codec/remote-source.ts",
  "lib/codec/relationships.ts",
  "lib/codec/scene-source.ts",
  "app/api/codec-scene/route.ts",
  "app/api/codec-stream/route.ts",
  "app/api/codec-evidence/route.ts",
  "app/api/codec-pack/[pack]/[expression]/route.ts",
  "app/codec/page.tsx",
  "components/codec/CodecView.tsx",
];

/** Module specifiers the codec graph must never import, directly or
 * transitively. Substring match against each import specifier. */
const FORBIDDEN_SPECIFIERS = [
  "coord-writer",
  "council-writer",
  "control-writer",
  "heartbeat-writer",
  "live-coordination-writer",
  "events/v3/bootstrap",
  "events/v3/live-routing",
  "events/v3/writer",
  "child_process",
  "node:child_process",
  "worker_threads",
];

const IMPORT_RE =
  /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = path.join(WEB_ROOT, spec.slice(2));
  } else if (spec.startsWith(".")) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    return null; // package import; judged by specifier only
  }
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith(path.sep)) return candidate;
  }
  return null;
}

function collectImports(file: string, seen: Set<string>, violations: string[]): void {
  if (seen.has(file)) return;
  seen.add(file);
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (!spec) continue;
    for (const forbidden of FORBIDDEN_SPECIFIERS) {
      if (spec.includes(forbidden)) {
        violations.push(`${path.relative(WEB_ROOT, file)} imports "${spec}"`);
      }
    }
    const resolved = resolveLocal(spec, file);
    if (resolved) collectImports(resolved, seen, violations);
  }
}

describe("codec dependency boundary", () => {
  test("no codec module reaches a write/control surface", () => {
    const violations: string[] = [];
    const seen = new Set<string>();
    let entriesFound = 0;
    for (const entry of ENTRYPOINTS) {
      const full = path.join(WEB_ROOT, entry);
      if (!existsSync(full)) continue;
      entriesFound += 1;
      collectImports(full, seen, violations);
    }
    // The core pipeline must exist for this test to mean anything.
    expect(entriesFound).toBeGreaterThanOrEqual(6);
    expect(violations).toEqual([]);
    // Sanity: the walk actually traversed shared modules, not just the roots.
    expect([...seen].some((f) => f.endsWith(`lib${path.sep}coord-reader.ts`))).toBe(true);
  });
});
