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
]);

const FORBIDDEN = [
  ".harnery/ledgers/v3",
  "eventV3Paths(",
  "readEventV3Catalog(",
  "readEventV3SegmentManifest(",
] as const;

export function scanEventV3ReaderBoundary(root: string): EventV3ReaderBoundaryViolation[] {
  const sourceRoot = join(root, "src");
  if (!existsSync(sourceRoot)) return [];
  const violations: EventV3ReaderBoundaryViolation[] = [];
  for (const absolute of walk(sourceRoot)) {
    const file = relative(root, absolute).split("\\").join("/");
    if (ALLOWED.has(file) || file.endsWith(".test.ts")) continue;
    const lines = readFileSync(absolute, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      for (const token of FORBIDDEN) {
        if (line.includes(token)) violations.push({ file, line: index + 1, token });
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

function walk(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...walk(path));
    else if (stat.isFile() && path.endsWith(".ts")) files.push(path);
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
