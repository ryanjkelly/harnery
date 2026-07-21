#!/usr/bin/env bun
/**
 * Public-surface provenance guard.
 *
 * Harnery is a public repository and package. Internal evaluation provenance
 * belongs in the private host workspace; public artifacts describe Harnery's
 * problem, alternatives, decision, and evidence without naming internal
 * evaluation sources. Restricted identifiers are stored only as SHA-256
 * fingerprints so the guard does not publish the source inventory it protects.
 *
 * Modes:
 *   bun run scripts/check-public-surface.ts
 *   bun run scripts/check-public-surface.ts --message-file <path>
 *   bun run scripts/check-public-surface.ts --git-range <base..head>
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

interface FingerprintFile {
  schemaVersion: number;
  fingerprints: string[];
}

const fingerprintFile = JSON.parse(
  readFileSync(join(import.meta.dir, "public-surface-fingerprints.json"), "utf8"),
) as FingerprintFile;
if (fingerprintFile.schemaVersion !== 1) {
  throw new Error(
    `Unsupported public-surface fingerprint schema: ${fingerprintFile.schemaVersion}`,
  );
}
if (
  !Array.isArray(fingerprintFile.fingerprints) ||
  fingerprintFile.fingerprints.length === 0 ||
  fingerprintFile.fingerprints.some((value) => !/^[a-f0-9]{64}$/.test(value)) ||
  new Set(fingerprintFile.fingerprints).size !== fingerprintFile.fingerprints.length
) {
  throw new Error("Invalid public-surface fingerprint file");
}
const RESTRICTED_FINGERPRINTS = new Set(fingerprintFile.fingerprints);

const PROVENANCE_LANGUAGE = [
  /\b(?:adapted|borrowed|copied|ported)\s+from\b/i,
  /\binspired\s+by\b/i,
  /\b(?:competitive|comparative)\s+(?:analysis|audit|research)\b/i,
  /\blandscape\s+(?:analysis|audit|research|scan)\b/i,
  /\bresearch\s+corpus\b/i,
];

const SCAN_ROOTS = [
  "src",
  "web",
  "docs",
  "schemas",
  "tests",
  "bin",
  "examples",
  ".changeset",
  ".github",
  ".claude",
  "scripts",
  "relay",
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  "package.json",
  "bun.lock",
];
const SCAN_EXTENSIONS = new Set([
  ".astro",
  ".cjs",
  ".css",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".lock",
  ".md",
  ".mdx",
  ".mjs",
  ".sh",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);
const SKIP_DIRECTORIES = new Set([
  ".astro",
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const SELF = new Set(["scripts/check-public-surface.ts", "tests/unit/public-surface.test.ts"]);
const LANGUAGE_WAIVER = "public-surface-allow:";
const MAX_IDENTIFIER_WORDS = 8;

export interface PublicSurfaceViolation {
  scope: string;
  line: number;
  kind: "restricted_identifier" | "provenance_language";
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function words(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function hasRestrictedIdentifier(line: string): boolean {
  const tokens = words(line);
  for (let start = 0; start < tokens.length; start++) {
    const limit = Math.min(tokens.length, start + MAX_IDENTIFIER_WORDS);
    for (let end = start + 1; end <= limit; end++) {
      if (RESTRICTED_FINGERPRINTS.has(fingerprint(tokens.slice(start, end).join(" ")))) {
        return true;
      }
    }
  }
  return false;
}

function safeScope(scope: string): string {
  return hasRestrictedIdentifier(scope)
    ? `restricted-scope-${fingerprint(scope).slice(0, 12)}`
    : scope;
}

export function scanPublicText(text: string, scope: string): PublicSurfaceViolation[] {
  const violations: PublicSurfaceViolation[] = [];
  const reportScope = safeScope(scope);
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (hasRestrictedIdentifier(line)) {
      violations.push({
        scope: reportScope,
        line: index + 1,
        kind: "restricted_identifier",
      });
    }
    if (
      !line.includes(LANGUAGE_WAIVER) &&
      PROVENANCE_LANGUAGE.some((pattern) => pattern.test(line))
    ) {
      violations.push({
        scope: reportScope,
        line: index + 1,
        kind: "provenance_language",
      });
    }
  }
  return violations;
}

function isScannableFile(path: string): boolean {
  const normalized = path.split("\\").join("/");
  if (SELF.has(normalized)) return false;
  return SCAN_ROOTS.some(
    (root) =>
      normalized === root ||
      (normalized.startsWith(`${root}/`) && SCAN_EXTENSIONS.has(extname(normalized))),
  );
}

function walk(dir: string, root: string, files: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const absolute = join(dir, entry);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(absolute, root, files);
    else {
      const rel = relative(root, absolute).split("\\").join("/");
      if (isScannableFile(rel)) files.push(absolute);
    }
  }
}

export function scanPublicSurface(root: string): PublicSurfaceViolation[] {
  const files: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    const absolute = join(root, scanRoot);
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(absolute, root, files);
    else if (isScannableFile(scanRoot)) files.push(absolute);
  }
  return files.flatMap((absolute) => {
    const rel = relative(root, absolute).split("\\").join("/");
    try {
      return [
        ...scanPublicText(rel, `path ${rel}`),
        ...scanPublicText(readFileSync(absolute, "utf8"), rel),
      ];
    } catch {
      return [];
    }
  });
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `git ${args[0]} failed`).trim());
  }
  return result.stdout;
}

/** Scan every commit's message and changed-file snapshot, not only the range's final diff. */
export function scanPublicHistory(root: string, range: string): PublicSurfaceViolation[] {
  const commits = git(root, ["rev-list", "--reverse", range]).split("\n").filter(Boolean);
  const violations: PublicSurfaceViolation[] = [];
  for (const commit of commits) {
    const short = commit.slice(0, 8);
    violations.push(
      ...scanPublicText(
        git(root, ["show", "-s", "--format=%B", commit]),
        `commit ${short} message`,
      ),
    );
    const changed = git(root, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      commit,
    ])
      .split("\n")
      .filter((path) => path && isScannableFile(path));
    for (const path of changed) {
      violations.push(...scanPublicText(path, `commit ${short} path ${path}`));
      const content = spawnSync("git", ["show", `${commit}:${path}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      if (content.status === 0) {
        violations.push(...scanPublicText(content.stdout, `commit ${short} ${path}`));
      }
    }
  }
  return violations;
}

export function formatPublicSurfaceViolations(violations: PublicSurfaceViolation[]): string {
  return violations
    .map((violation) => `  ${violation.scope}:${violation.line} [${violation.kind}]`)
    .join("\n");
}

function reportAndExit(violations: PublicSurfaceViolation[]): never {
  console.error(`public-surface: ${violations.length} restricted provenance reference(s) found:\n`);
  console.error(formatPublicSurfaceViolations(violations));
  console.error(
    "\nMove evaluation provenance to the private host workspace. Public Harnery artifacts must describe only the problem, alternatives, decision, and evidence.",
  );
  process.exit(1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const messageIndex = args.indexOf("--message-file");
  const rangeIndex = args.indexOf("--git-range");
  let violations: PublicSurfaceViolation[];
  if (messageIndex !== -1) {
    const path = args[messageIndex + 1];
    if (!path) throw new Error("--message-file requires a path");
    violations = scanPublicText(readFileSync(path, "utf8"), "commit message");
  } else if (rangeIndex !== -1) {
    const range = args[rangeIndex + 1];
    if (!range) throw new Error("--git-range requires <base..head>");
    violations = scanPublicHistory(process.cwd(), range);
  } else {
    violations = scanPublicSurface(args[0] ?? process.cwd());
  }
  if (violations.length > 0) reportAndExit(violations);
  console.log("public-surface: clean; no restricted evaluation provenance found.");
}
