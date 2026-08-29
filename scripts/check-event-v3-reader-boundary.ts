#!/usr/bin/env bun
/** Guard the single-reader rule from ADR 0080. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface EventV3ReaderBoundaryViolation {
  file: string;
  line: number;
  token: string;
}

const ALLOWED = new Set([
  "src/core/events/v3/catalog.ts",
  "src/core/events/v3/control.ts",
  "src/core/events/v3/authority-outbox.ts",
  "src/core/events/v3/reader.ts",
  "src/core/events/v3/writer.ts",
  // Public instruction prose names the ledger location; it does not traverse it.
  "src/lib/instructions/templates.ts",
  "web/lib/coord-reader.ts",
  "web/lib/codec/scene-source.ts",
]);

const STORAGE_CATALOG = "src/core/storage/builtins.ts";
const STORAGE_CATALOG_INVENTORY_DECLARATIONS = new Set([
  'exact(context, ".harnery/ledgers/v3/active.ndjson", "file"),',
  'exact(context, ".harnery/ledgers/v3/catalog.json", "file"),',
  'exact(context, ".harnery/ledgers/v3/genesis.json", "file"),',
  'exact(context, ".harnery/ledgers/v3/activation.json", "file"),',
  'subtree(context, ".harnery/ledgers/v3/segments"),',
  'partition(context, ".harnery/ledgers/v3-archives", "canonical", [',
  'subtree(context, ".harnery/ledgers/v3/diagnostics"),',
  'subtree(context, ".harnery/ledgers/v3/diagnostic-summaries"),',
  'subtree(context, ".harnery/ledgers/v3/private-producers"),',
  'subtree(context, ".harnery/ledgers/v3/authority-outbox"),',
  'subtree(context, ".harnery/ledgers/v3/authority-recoveries"),',
  'subtree(context, ".harnery/ledgers/v3/intake"),',
  'subtree(context, ".harnery/ledgers/v3/spool"),',
  'subtree(context, ".harnery/ledgers/v3/quarantine"),',
  'exact(context, ".harnery/ledgers/v3/append-lease", "file"),',
  'partition(context, ".harnery/ledgers/v3-archives", "support", [',
  'roots: (context) => [subtree(context, ".harnery/ledgers/v3-recoveries")],',
]);

const FORBIDDEN = [
  ".harnery/ledgers/v3",
  "eventV3Paths(",
  "readEventV3Catalog(",
  "readEventV3SegmentManifest(",
] as const;

export function scanEventV3ReaderBoundary(root: string): EventV3ReaderBoundaryViolation[] {
  const sourceRoots = [join(root, "src"), join(root, "web")].filter(existsSync);
  if (sourceRoots.length === 0) return [];
  const violations: EventV3ReaderBoundaryViolation[] = [];
  for (const absolute of sourceRoots.flatMap(walk)) {
    const file = relative(root, absolute).split("\\").join("/");
    if (ALLOWED.has(file) || file.endsWith(".test.ts")) continue;
    const lines = readFileSync(absolute, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      for (const token of FORBIDDEN) {
        if (line.includes(token) && !isAllowedStorageCatalogInventory(file, line, token)) {
          violations.push({ file, line: index + 1, token });
        }
      }
    }
  }
  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.token.localeCompare(right.token),
  );
}

function isAllowedStorageCatalogInventory(file: string, line: string, token: string): boolean {
  return (
    token === ".harnery/ledgers/v3" &&
    file === STORAGE_CATALOG &&
    STORAGE_CATALOG_INVENTORY_DECLARATIONS.has(line.trim())
  );
}

function walk(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...walk(path));
    else if (stat.isFile() && (path.endsWith(".ts") || path.endsWith(".tsx"))) files.push(path);
  }
  return files;
}

if (import.meta.main) {
  const root = process.argv[2] ?? process.cwd();
  const violations = scanEventV3ReaderBoundary(root);
  if (violations.length === 0) {
    console.log(
      "event-v3-reader-boundary: clean — filesystem traversal stays inside the canonical reader.",
    );
    process.exit(0);
  }
  console.error(`event-v3-reader-boundary: ${violations.length} direct traversal violation(s):`);
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} (${violation.token})`);
  }
  console.error(
    "Consumers must call readLedgerV3/readLedgerV3Since instead of traversing V3 storage.",
  );
  process.exit(1);
}
