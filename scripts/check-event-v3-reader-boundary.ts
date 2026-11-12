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
  'subtree(context, ".harnery/ledgers/v3/diagnostics", OWNER_PROTOCOL_LINKS),',
  'subtree(context, ".harnery/ledgers/v3/diagnostic-summaries", OWNER_PROTOCOL_LINKS),',
  'subtree(context, ".harnery/ledgers/v3/private-producers", OWNER_PROTOCOL_LINKS),',
  'subtree(context, ".harnery/ledgers/v3/authority-outbox", OWNER_PROTOCOL_LINKS),',
  'subtree(context, ".harnery/ledgers/v3/authority-recoveries", OWNER_PROTOCOL_LINKS),',
  'subtree(context, ".harnery/ledgers/v3/intake", OWNER_PROTOCOL_LINKS),',
  'subtree(context, ".harnery/ledgers/v3/spool", OWNER_PROTOCOL_LINKS),',
  'subtree(context, ".harnery/ledgers/v3/quarantine", OWNER_PROTOCOL_LINKS),',
  'exact(context, ".harnery/ledgers/v3/append-lease", "directory"),',
  'exact(context, ".harnery/ledgers/v3/control-state-witness.json", "file"),',
  'exact(context, ".harnery/ledgers/v3/control-state-validation.json", "file"),',
  '".harnery/ledgers/v3-archives",',
  'roots: (context) => [subtree(context, ".harnery/ledgers/v3-recoveries")],',
]);

const FORBIDDEN = [
  ".harnery/ledgers/v3",
  "eventV3Paths(",
  "readEventV3Catalog(",
  "readEventV3SegmentManifest(",
] as const;

/**
 * The same storage location spelled as path segments, e.g.
 * `join(root, ".harnery", "ledgers", "v3")`. Like the string token it covers
 * the active ledger and its `v3-archives` and `v3-recoveries` siblings. It is
 * matched across the whole file so a call wrapped over several lines is caught.
 */
export const LEDGER_SEGMENT_JOIN_TOKEN = '"ledgers", "v3"';
const LEDGER_SEGMENT_JOIN = /["'`]ledgers["'`]\s*,\s*["'`]v3(?=["'`-])/g;

export interface EventV3ReaderBoundaryException {
  file: string;
  token: string;
  /** The exact trimmed source line. Any other line in the file is still checked. */
  declaration: string;
  reason: string;
}

/**
 * Exact declarations outside the allowed modules that may name V3 storage.
 * Each entry is one line in one file; prefer importing a location from its
 * owner over adding an entry here.
 */
export const EXACT_DECLARATION_EXCEPTIONS: readonly EventV3ReaderBoundaryException[] = [
  {
    file: "src/core/events/v3/archive-retention.ts",
    token: LEDGER_SEGMENT_JOIN_TOKEN,
    declaration: 'return join(resolve(repoRoot), ".harnery", "ledgers", "v3-archives");',
    reason:
      "eventV3ArchivesRoot is the single owner of the closed-epoch root; other modules import it.",
  },
  {
    file: "src/core/events/v3/thread-leases.ts",
    token: LEDGER_SEGMENT_JOIN_TOKEN,
    declaration: 'const LEDGER_ROOT_SEGMENTS = [".harnery", "ledgers", "v3"] as const;',
    reason:
      "Locates producer and summary lease directories only; it stays free of the reader and writer so a host's supervising thread can load it.",
  },
  {
    file: "src/core/events/v3/recovery-record.ts",
    token: LEDGER_SEGMENT_JOIN_TOKEN,
    declaration: 'return join(resolve(coordRoot), ".harnery", "ledgers", "v3-recoveries");',
    reason: "The single owner of the recovery-record root, a sibling of the ledger, not a segment.",
  },
];

export function scanEventV3ReaderBoundary(root: string): EventV3ReaderBoundaryViolation[] {
  const sourceRoots = [join(root, "src"), join(root, "web")].filter(existsSync);
  if (sourceRoots.length === 0) return [];
  const violations: EventV3ReaderBoundaryViolation[] = [];
  for (const absolute of sourceRoots.flatMap(walk)) {
    const file = relative(root, absolute).split("\\").join("/");
    if (ALLOWED.has(file) || file.endsWith(".test.ts")) continue;
    const text = readFileSync(absolute, "utf8");
    const lines = text.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const token of FORBIDDEN) {
        if (line.includes(token) && !isAllowedStorageCatalogInventory(file, line, token)) {
          violations.push({ file, line: index + 1, token });
        }
      }
    }
    for (const match of text.matchAll(LEDGER_SEGMENT_JOIN)) {
      const lineIndex = text.slice(0, match.index).split("\n").length - 1;
      if (isExactDeclarationException(file, lines[lineIndex] ?? "", LEDGER_SEGMENT_JOIN_TOKEN)) {
        continue;
      }
      violations.push({ file, line: lineIndex + 1, token: LEDGER_SEGMENT_JOIN_TOKEN });
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

function isExactDeclarationException(file: string, line: string, token: string): boolean {
  const declaration = line.trim();
  return EXACT_DECLARATION_EXCEPTIONS.some(
    (entry) => entry.file === file && entry.token === token && entry.declaration === declaration,
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
