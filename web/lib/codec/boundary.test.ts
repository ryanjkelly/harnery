/**
 * Dependency-boundary test: the Codec director is read-only by construction.
 *
 * Walks the import graph of every codec module (lib + routes + UI) and fails
 * if any path reaches a Harnery write/control surface: coordination writers,
 * council/decision writers, process launchers, or the CLI. The root resolver's
 * fixed read-only Git query is the sole checked process exception. This is the
 * plan's "module layering must prevent imports from coord-writer, process
 * launchers, agent messaging, lifecycle commands, and workflow controls"
 * requirement, enforced.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

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
  "components/codec/CodecRosterExpressions.tsx",
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

function runtimeImports(source: string): string[] {
  const imports: string[] = [];
  const file = ts.createSourceFile(
    "module.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const add = (specifier: ts.Node | undefined) => {
    if (specifier && ts.isStringLiteralLike(specifier)) imports.push(specifier.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return imports;
}

/** Permit only the existing fixed Git path probe, never arbitrary process control. */
function readOnlyGitRootResolver(source: string): boolean {
  const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  let spawnReferences = 0;
  let probeReferences = 0;
  let processImports = 0;
  let spawns = 0;
  let probes = 0;
  let safe = true;
  const stringIs = (node: ts.Node | undefined, text: string) =>
    !!node && ts.isStringLiteral(node) && node.text === text;
  const identifierIs = (node: ts.Node | undefined, text: string) =>
    !!node && ts.isIdentifier(node) && node.text === text;
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === "spawnSync") spawnReferences += 1;
    if (ts.isIdentifier(node) && node.text === "gitRevParse") probeReferences += 1;
    if (ts.isImportDeclaration(node) && stringIs(node.moduleSpecifier, "node:child_process")) {
      processImports += 1;
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      safe &&=
        !!clause &&
        !clause.name &&
        !!bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length === 1 &&
        identifierIs(bindings.elements[0]?.name, "spawnSync") &&
        !bindings.elements[0]?.propertyName;
    }
    if (ts.isFunctionDeclaration(node) && identifierIs(node.name, "gitRevParse")) {
      safe &&= !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    }
    if (ts.isCallExpression(node) && identifierIs(node.expression, "spawnSync")) {
      spawns += 1;
      const [command, args, options] = node.arguments;
      safe &&=
        node.arguments.length === 3 &&
        stringIs(command, "git") &&
        !!args &&
        ts.isArrayLiteralExpression(args) &&
        args.elements.length === 2 &&
        stringIs(args.elements[0], "rev-parse") &&
        identifierIs(args.elements[1], "flag") &&
        !!options &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.length === 2 &&
        options.properties.every(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ((identifierIs(property.name, "cwd") && identifierIs(property.initializer, "start")) ||
              (identifierIs(property.name, "encoding") && stringIs(property.initializer, "utf8"))),
        );
    }
    if (ts.isCallExpression(node) && identifierIs(node.expression, "gitRevParse")) {
      probes += 1;
      const flag = node.arguments[1];
      safe &&=
        node.arguments.length === 2 &&
        !!flag &&
        ts.isStringLiteral(flag) &&
        ["--show-superproject-working-tree", "--git-common-dir", "--show-toplevel"].includes(
          flag.text,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return (
    safe &&
    spawns === 1 &&
    spawnReferences === 2 &&
    probeReferences === 4 &&
    processImports === 1 &&
    probes === 3 &&
    runtimeImports(source).filter((specifier) => specifier.includes("child_process")).length === 1
  );
}

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
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
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
  for (const spec of runtimeImports(source)) {
    for (const forbidden of FORBIDDEN_SPECIFIERS) {
      if (spec.includes(forbidden)) {
        if (
          spec === "node:child_process" &&
          file === path.resolve(WEB_ROOT, "../src/core/hooks/resolve/coord-root.ts") &&
          readOnlyGitRootResolver(source)
        )
          continue;
        violations.push(`${path.relative(WEB_ROOT, file)} imports "${spec}"`);
      }
    }
    const resolved = resolveLocal(spec, file);
    if (resolved) collectImports(resolved, seen, violations);
  }
}

describe("codec dependency boundary", () => {
  test("directory imports resolve to their index module instead of skipping its imports", () => {
    const fromFile = path.resolve(WEB_ROOT, "../src/core/entry.ts");
    expect(resolveLocal("./presence", fromFile)).toBe(
      path.resolve(WEB_ROOT, "../src/core/presence/index.ts"),
    );
    expect(resolveLocal("./missing-directory", fromFile)).toBeNull();
  });

  test("the root resolver exception rejects write commands, shell options, and process aliases", () => {
    const source = readFileSync(
      path.resolve(WEB_ROOT, "../src/core/hooks/resolve/coord-root.ts"),
      "utf8",
    );
    expect(readOnlyGitRootResolver(source)).toBe(true);
    expect(readOnlyGitRootResolver(source.replace('spawnSync("git"', 'spawnSync("sh"'))).toBe(
      false,
    );
    expect(readOnlyGitRootResolver(source.replace('"rev-parse"', '"reset"'))).toBe(false);
    expect(readOnlyGitRootResolver(source.replace('"--show-toplevel"', '"--delete"'))).toBe(false);
    expect(
      readOnlyGitRootResolver(
        source.replace('encoding: "utf8",', 'encoding: "utf8", shell: true,'),
      ),
    ).toBe(false);
    expect(readOnlyGitRootResolver(`${source}\nconst launch = spawnSync;`)).toBe(false);
    expect(
      readOnlyGitRootResolver(
        source.replace("function gitRevParse", "export function gitRevParse"),
      ),
    ).toBe(false);
    expect(readOnlyGitRootResolver(source.replace("{ spawnSync }", "{ spawnSync, exec }"))).toBe(
      false,
    );
  });

  test("type-only imports, type queries, and comments do not load modules", () => {
    expect(
      runtimeImports(`
      import type { State } from "./writer";
      export type { State } from "./writer";
      type State = import("./writer").State;
      // import { write } from "./writer";
    `),
    ).toEqual([]);
  });

  test("runtime imports retain side effects, re-exports, and process loaders", () => {
    expect(
      runtimeImports(`
      import "node:child_process";
      import { type State, write } from "./writer";
      export { write } from "./writer";
      export * from "./control-writer";
      const loader = import("node:worker_threads");
      const process = require("child_process");
      import control = require("./control-writer");
    `),
    ).toEqual([
      "node:child_process",
      "./writer",
      "./writer",
      "./control-writer",
      "node:worker_threads",
      "child_process",
      "./control-writer",
    ]);
  });

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
