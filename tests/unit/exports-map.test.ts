import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The exports map names every public entry point (ADR 0010), and a rename that
// moves a source directory without updating it leaves a subpath pointing at
// nothing. That failure is invisible to lint, typecheck, and the unit suite:
// `tsc` never reads the map, and a stale `dist/` (gitignored, and not pruned by
// a rebuild) keeps satisfying the built path on the machine that did the
// rename. It surfaces only when a fresh checkout builds and a consumer imports
// the subpath. Renaming src/core/supervisor to src/core/governor shipped
// exactly that way: three `./core/supervisor*` subpaths survived, resolving
// locally against leftover build output.
//
// The `bun` condition points into `src/`, so it is checkable without building
// and is the condition an embedding host resolves. The `types`/`import`
// conditions point into `dist/` and are covered by scripts/smoke-test.mjs,
// which builds from clean and imports each public subpath on Node.
describe("exports map", () => {
  const root = join(import.meta.dir, "..", "..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    exports: Record<string, Record<string, string>>;
    files: string[];
  };
  const buildConfig = JSON.parse(readFileSync(join(root, "tsconfig.build.json"), "utf8")) as {
    exclude: string[];
  };

  const requiredFeatureSubpaths = [
    "./core/storage",
    "./core/inbox",
    "./core/conversations",
    "./core/events/v3",
    "./core/events/v3/support-storage",
    "./core/events/legacy-storage",
  ];

  const sourceTargets = Object.entries(pkg.exports)
    .map(([subpath, conditions]) => ({ subpath, target: conditions.bun }))
    .filter((entry): entry is { subpath: string; target: string } =>
      Boolean(entry.target?.startsWith("./")),
    );

  test("every subpath declares a source target to check", () => {
    // If the map ever stops carrying `bun` conditions this guard would pass on
    // an empty list. Fail loud instead.
    expect(sourceTargets.length).toBeGreaterThan(0);
  });

  test("every declared source target exists on disk", () => {
    const dangling = sourceTargets.filter(({ target }) => !existsSync(join(root, target)));
    if (dangling.length > 0) {
      const report = dangling.map(({ subpath, target }) => `  ${subpath} -> ${target}`).join("\n");
      throw new Error(
        `${dangling.length} export subpath(s) point at a missing source file:\n${report}\n` +
          "Update package.json exports to the moved path, or drop the subpath.",
      );
    }
  });

  test("release features have explicit public subpaths", () => {
    expect(Object.keys(pkg.exports)).toEqual(expect.arrayContaining(requiredFeatureSubpaths));
  });

  test("internal fixtures cannot enter the published package", () => {
    expect(buildConfig.exclude).toContain("**/__fixtures__/**");
    expect(pkg.files).toContain("!src/**/__fixtures__/**");
    expect(pkg.files).toContain("!dist/**/__fixtures__/**");
  });
});
