#!/usr/bin/env bun
/**
 * Layering guard — the exports map is the tier boundary, and this script keeps
 * it honest. harnery's public surface has two tiers (see ADR 0010):
 *
 *   - Product tier: `.`, `./commander`, `./core/*` — the coordination layer.
 *     What harnery is FOR; imports whatever it needs.
 *   - Toolkit tier: every `./lib/*` subpath export — supporting utilities
 *     (http, cookies, format, readability, browser, machine, …) made available
 *     to host CLIs that embed harnery.
 *
 * The rule enforced here: **no toolkit export may reach `src/core/`,
 * directly or transitively.** That is what makes the toolkit safe to depend
 * on as plain utilities — importing `harnery/lib/http` must never drag in
 * coordination state, heartbeats, or hook machinery. Product code importing
 * the toolkit is fine (that's the point of having a toolkit); only the
 * upward direction is forbidden.
 *
 * There is deliberately NO per-line escape hatch. If a toolkit module
 * legitimately needs the coordination core, it is not a toolkit module —
 * move its export under `./core/*` instead (that's what happened to
 * `scratch`, the mismatch that motivated this guard).
 *
 * Run:  bun run scripts/check-layering.ts   (exits 1 on any violation)
 * Test: tests/unit/layering.test.ts asserts zero violations in CI.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface LayeringViolation {
  /** The `./lib/*` export whose dependency graph reached core. */
  export_key: string;
  /** Repo-relative import chain from the export's entry file to the core file. */
  chain: string[];
}

interface ExportEntry {
  key: string;
  /** Repo-relative source entry (the `bun` condition, falling back to `import`). */
  entry: string;
}

/** Pull every `./lib/*` subpath export and its source entry from package.json. */
export function toolkitExports(root: string): ExportEntry[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const exports: Record<string, Record<string, string>> = pkg.exports ?? {};
  const out: ExportEntry[] = [];
  for (const [key, value] of Object.entries(exports)) {
    if (!key.startsWith("./lib/")) continue;
    const entry = value.bun ?? value.import;
    if (!entry) continue;
    out.push({ key, entry: entry.replace(/^\.\//, "") });
  }
  return out;
}

/** Extract import/export-from/dynamic-import specifiers from a TS/JS source. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
    m = re.exec(source);
  }
  return specs;
}

/** Resolve a relative specifier to a repo-relative file path (or null if unresolvable). */
function resolveRelative(root: string, fromFile: string, spec: string): string | null {
  const base = resolve(root, dirname(fromFile), spec);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        return relative(root, c).split("\\").join("/");
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * BFS the transitive relative-import graph from each toolkit export's entry
 * file; a violation is any path that lands in `src/core/` (or a self-import
 * of `harnery/core/...`).
 */
export function scanLayering(root: string): LayeringViolation[] {
  const violations: LayeringViolation[] = [];

  for (const { key, entry } of toolkitExports(root)) {
    const parent = new Map<string, string | null>([[entry, null]]);
    const queue: string[] = [entry];
    let coreHit: string | null = null;

    while (queue.length > 0 && coreHit === null) {
      const file = queue.shift();
      if (file === undefined) break;
      let source: string;
      try {
        source = readFileSync(join(root, file), "utf8");
      } catch {
        continue;
      }
      for (const spec of importSpecifiers(source)) {
        let target: string | null = null;
        if (spec.startsWith(".")) {
          target = resolveRelative(root, file, spec);
        } else if (spec.startsWith("harnery/core") || spec === "harnery") {
          // Self-referencing the product surface from the toolkit counts too.
          target = `(package import: ${spec})`;
          parent.set(target, file);
          coreHit = target;
          break;
        }
        if (target === null || parent.has(target)) continue;
        parent.set(target, file);
        if (target.startsWith("src/core/")) {
          coreHit = target;
          break;
        }
        queue.push(target);
      }
    }

    if (coreHit !== null) {
      const chain: string[] = [];
      let cursor: string | null = coreHit;
      while (cursor !== null) {
        chain.unshift(cursor);
        cursor = parent.get(cursor) ?? null;
      }
      violations.push({ export_key: key, chain });
    }
  }

  return violations.sort((a, b) => a.export_key.localeCompare(b.export_key));
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const violations = scanLayering(root);
  if (violations.length === 0) {
    const count = toolkitExports(root).length;
    console.log(`layering: clean — ${count} toolkit export(s) verified free of src/core imports.`);
    process.exit(0);
  }
  console.error(`layering: ${violations.length} toolkit export(s) reach the coordination core:\n`);
  for (const v of violations) {
    console.error(`  ${v.export_key}`);
    console.error(`    ${v.chain.join("\n      -> ")}`);
  }
  console.error(
    `\nToolkit exports (./lib/*) must stay importable without dragging in coordination state.`,
  );
  console.error(
    `Either drop the core dependency, or reclassify the module by moving its export under ./core/* (no per-line waiver exists on purpose).`,
  );
  process.exit(1);
}
