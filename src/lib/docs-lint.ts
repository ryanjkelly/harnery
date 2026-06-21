import { existsSync as __existsSyncForDocs } from "node:fs";
import { resolve as __resolveForDocs } from "node:path";
import { sh } from "./exec.ts";

// Module-level docs context, initialized by initDocsContext() before any
// other function in this file is called. Consumers pass repo metadata
// + an optional list of extra excluded path prefixes for project-specific
// directories that shouldn't be subject to doc-lint conventions.
let REPO_ROOT = "";
let SUBMODULES: readonly string[] = [];
let EXTRA_EXCLUDED_PREFIXES: readonly string[] = [];

export function initDocsContext(opts: {
  repoRoot: string;
  submodules: readonly string[];
  extraExcludedPrefixes?: readonly string[];
}): void {
  REPO_ROOT = opts.repoRoot;
  SUBMODULES = opts.submodules;
  EXTRA_EXCLUDED_PREFIXES = opts.extraExcludedPrefixes ?? [];
}

function submodulePath(name: string): string {
  return __resolveForDocs(REPO_ROOT, name);
}

function isSubmoduleInitialized(name: string): boolean {
  return __existsSyncForDocs(__resolveForDocs(REPO_ROOT, name, ".git"));
}

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * Documentation linter. Enforces the docs directory-layout + naming contract.
 *
 * Each violation carries a severity: `error` fails the lint, `warning` is
 * informational. `--fast` mode skips content-reading checks so the pre-commit
 * hook stays cheap.
 */

export type Severity = "error" | "warning";

export interface Violation {
  severity: Severity;
  repo: string;
  path: string; // relative to monorepo root
  rule: string;
  message: string;
}

export interface LintOpts {
  fast?: boolean;
  repo?: string; // limit to one submodule or "." for parent
}

/** Files allowed at a submodule root level. Includes:
 *  - In-repo conventions: README.md, CLAUDE.md, LLM-BRIEFING.md, AGENTS.md
 *  - GitHub OSS conventions: CHANGELOG.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md,
 *    SECURITY.md, SUPPORT.md, AUTHORS.md, MAINTAINERS.md, PULL_REQUEST_TEMPLATE.md
 *    (these are recognized by the GitHub UI, and renaming them breaks the integration)
 */
const ROOT_FILE_ALLOWLIST = new Set([
  "README.md",
  "CLAUDE.md",
  "LLM-BRIEFING.md",
  "AGENTS.md",
  // GitHub-recognized OSS package files
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "AUTHORS.md",
  "MAINTAINERS.md",
  "PULL_REQUEST_TEMPLATE.md",
]);

/** Paths that are excluded from markdown discipline even when git-tracked.
 *
 * Covers auto-generated reference dumps and vendored content pages that happen
 * to be checked into git but aren't subject to doc conventions. Paths are
 * relative to the scanned repo root; any file under one of these prefixes is
 * ignored.
 *
 * Note: git-ignored directories (node_modules, .venv, vendor, dbt_packages,
 * target, dist, build) are already excluded because we use `git ls-files`.
 */
// Built-in exclusions: auto-generated/framework dirs that ship in any
// project. Consumers extend this via `extraExcludedPrefixes` in
// initDocsContext for their own project-specific dirs (auto-generated
// API references, vendored content, etc.).
const EXCLUDED_PREFIXES = [
  ".agents/", // canonical AI-config sources (skills, subagents, rules, claude-addendum)
  ".claude/", // Claude Code framework files (SKILL.md, agents)
  ".harnery/", // harnery coord/skill state
  ".codex/", // OpenAI Codex framework files (skills/, agents/)
  ".cursor/", // auto-generated Cursor rules
];

/** Filename patterns that should never exist */
const FORBIDDEN_ROOT_NAMES = new Set([
  "TODO.md",
  "PROJECT.md",
  "VISION.md",
  "NOTES.md",
  "DECISIONS.md", // should be docs/decisions.md
  "CHANGELOG.md", // should be docs/changelogs/YYYY-MM.md
]);

/** YYYY-MM-DD_<slug>.md */
const DATED_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}_[a-z0-9][a-z0-9_-]*\.md$/i;

/** YYYY-MM.md for changelogs */
const CHANGELOG_PATTERN = /^\d{4}-\d{2}\.md$/;

/** SCREAMING_SNAKE_CASE.md, excluding allowlisted entry files */
const SCREAMING_SNAKE_PATTERN = /^[A-Z][A-Z0-9_]+\.md$/;

/** kebab-case.md: lowercase letters, digits, hyphens */
const KEBAB_CASE_PATTERN = /^[a-z0-9][a-z0-9-]*\.md$/;

/** Target repos to lint: parent + every initialized submodule */
function getTargetRepos(opts: LintOpts): { name: string; path: string; isSubmodule: boolean }[] {
  const all: { name: string; path: string; isSubmodule: boolean }[] = [
    { name: "(root)", path: REPO_ROOT, isSubmodule: false },
  ];
  for (const name of SUBMODULES) {
    if (!isSubmoduleInitialized(name)) continue;
    all.push({ name, path: submodulePath(name), isSubmodule: true });
  }
  if (opts.repo) {
    const filter = opts.repo === "." ? "(root)" : opts.repo;
    return all.filter((r) => r.name === filter);
  }
  return all;
}

/** List all tracked .md files in the given repo via `git ls-files`.
 * Returns paths relative to the repo root. Automatically skips node_modules,
 * vendor, .venv, dbt_packages, build/ etc. because they're gitignored.
 */
async function findMarkdownFiles(root: string): Promise<string[]> {
  const result = await sh('git ls-files --cached "**/*.md" "*.md"', { cwd: root });
  if (result.exitCode !== 0 || !result.stdout) return [];
  return result.stdout
    .split("\n")
    .filter((f) => f.endsWith(".md"))
    .filter(
      (f) =>
        // Framework dirs are excluded at any depth, not just repo root;
        // in-tree repos (monorepos like harnery) nest .claude/.agents/etc.
        !EXCLUDED_PREFIXES.some((p) => f.startsWith(p) || f.includes(`/${p}`)) &&
        !EXTRA_EXCLUDED_PREFIXES.some((p) => f.startsWith(p) || f.includes(`/${p}`)),
    );
}

/** Read first N lines of a file for header inspection */
function readHead(path: string, lines = 20): string {
  try {
    const content = readFileSync(path, "utf8");
    return content.split("\n").slice(0, lines).join("\n");
  } catch {
    return "";
  }
}

/** Detect whether a file declares itself an intentional monolith */
function isDeclaredMonolith(path: string): boolean {
  const head = readHead(path, 10);
  return /INTENTIONAL-MONOLITH/i.test(head);
}

/** Detect whether a file carries a Status line in its opening block */
function hasStatusHeader(path: string): boolean {
  const head = readHead(path, 15);
  return /\*\*Status:\*\*/i.test(head);
}

// --- Individual checks ---

/** Entry tier files exist at the repo root */
function checkEntryTier(repoName: string, repoPath: string, isSubmodule: boolean): Violation[] {
  const violations: Violation[] = [];
  // README.md is required for any repo
  if (!existsSync(join(repoPath, "README.md"))) {
    violations.push({
      severity: "error",
      repo: repoName,
      path: join(repoName === "(root)" ? "" : repoName, "README.md"),
      rule: "entry-tier",
      message: "README.md missing at repo root",
    });
  }
  // CLAUDE.md required for submodules (primary LLM context)
  if (isSubmodule && !existsSync(join(repoPath, "CLAUDE.md"))) {
    violations.push({
      severity: "error",
      repo: repoName,
      path: join(repoName, "CLAUDE.md"),
      rule: "entry-tier",
      message: "CLAUDE.md missing: primary LLM context file",
    });
  }
  return violations;
}

/** No forbidden root-level files */
function checkRootAllowlist(repoName: string, repoPath: string): Violation[] {
  const violations: Violation[] = [];
  let entries: string[];
  try {
    entries = readdirSync(repoPath);
  } catch {
    return violations;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    if (ROOT_FILE_ALLOWLIST.has(entry)) continue;
    const displayPath = join(repoName === "(root)" ? "" : repoName, entry);
    if (FORBIDDEN_ROOT_NAMES.has(entry)) {
      violations.push({
        severity: "error",
        repo: repoName,
        path: displayPath,
        rule: "forbidden-root-file",
        message: `${entry} is not allowed at repo root`,
      });
    } else if (SCREAMING_SNAKE_PATTERN.test(entry)) {
      violations.push({
        severity: "error",
        repo: repoName,
        path: displayPath,
        rule: "root-caps-file",
        message: `${entry} is an ad-hoc caps file at repo root: entry tier is reserved for README.md / CLAUDE.md / LLM-BRIEFING.md / AGENTS.md`,
      });
    }
  }
  return violations;
}

/** No SCREAMING_SNAKE_CASE filenames anywhere */
function checkNamingConvention(repoName: string, _repoPath: string, files: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const rel of files) {
    const name = basename(rel);
    // Allowlisted names
    if (ROOT_FILE_ALLOWLIST.has(name)) continue;
    // Dated files (audits/issues)
    if (DATED_FILE_PATTERN.test(name)) continue;
    // Changelogs
    if (CHANGELOG_PATTERN.test(name)) continue;
    // decisions.md, runbook.md: explicit
    if (name === "decisions.md" || name === "runbook.md") continue;
    // Known-good kebab-case
    if (KEBAB_CASE_PATTERN.test(name)) continue;
    // README.md inside a subdir is fine
    if (name === "README.md") continue;
    // SCREAMING_SNAKE_CASE violations
    if (SCREAMING_SNAKE_PATTERN.test(name)) {
      violations.push({
        severity: "error",
        repo: repoName,
        path: join(repoName === "(root)" ? "" : repoName, rel),
        rule: "screaming-snake-case",
        message: `filename ${name} uses SCREAMING_SNAKE_CASE; rename to kebab-case`,
      });
      continue;
    }
    // Anything else that's not kebab-case is a warning (Title Case, mixed)
    if (!/^[a-z0-9]/.test(name)) {
      violations.push({
        severity: "warning",
        repo: repoName,
        path: join(repoName === "(root)" ? "" : repoName, rel),
        rule: "non-kebab-filename",
        message: `filename ${name} is not kebab-case`,
      });
    }
  }
  return violations;
}

/** Files in docs/audits/ and docs/issues/ must match YYYY-MM-DD_<slug>.md */
function checkDatedDirs(repoName: string, _repoPath: string, files: string[]): Violation[] {
  const violations: Violation[] = [];
  const datedDirs = ["docs/audits/", "docs/issues/"];
  for (const rel of files) {
    for (const d of datedDirs) {
      if (!rel.startsWith(d)) continue;
      const name = basename(rel);
      // README.md is the index file, allowed
      if (name === "README.md") continue;
      if (!DATED_FILE_PATTERN.test(name)) {
        violations.push({
          severity: "error",
          repo: repoName,
          path: join(repoName === "(root)" ? "" : repoName, rel),
          rule: "undated-in-dated-dir",
          message: `${d} file must match YYYY-MM-DD_<slug>.md; got ${name}`,
        });
      }
    }
  }
  return violations;
}

/** Changelog files must match YYYY-MM.md */
function checkChangelogNames(repoName: string, _repoPath: string, files: string[]): Violation[] {
  const violations: Violation[] = [];
  for (const rel of files) {
    if (!rel.startsWith("docs/changelogs/")) continue;
    const name = basename(rel);
    if (name === "README.md") continue;
    if (!CHANGELOG_PATTERN.test(name)) {
      violations.push({
        severity: "error",
        repo: repoName,
        path: join(repoName === "(root)" ? "" : repoName, rel),
        rule: "bad-changelog-name",
        message: `changelog must match YYYY-MM.md; got ${name}`,
      });
    }
  }
  return violations;
}

/** Plans and issues must carry a Status header (content check, slow) */
function checkStatusHeaders(repoName: string, repoPath: string, files: string[]): Violation[] {
  const violations: Violation[] = [];
  const targetDirs = ["docs/plans/", "docs/issues/"];
  for (const rel of files) {
    const dirMatch = targetDirs.some((d) => rel.startsWith(d));
    if (!dirMatch) continue;
    const name = basename(rel);
    if (name === "README.md") continue;
    // Skip archive subdir
    if (rel.includes("/archive/")) continue;
    const full = join(repoPath, rel);
    if (!hasStatusHeader(full)) {
      const kind = rel.startsWith("docs/plans/") ? "plan" : "issue";
      violations.push({
        severity: "warning",
        repo: repoName,
        path: join(repoName === "(root)" ? "" : repoName, rel),
        rule: "missing-status-header",
        message: `${kind} missing **Status:** line in opening block`,
      });
    }
  }
  return violations;
}

/** Intentional monoliths >30KB need a declaration banner */
function checkMonolithDeclaration(
  repoName: string,
  repoPath: string,
  files: string[],
): Violation[] {
  const violations: Violation[] = [];
  const SIZE_THRESHOLD = 30 * 1024;
  for (const rel of files) {
    // Only flag top-level docs/ files, not per-repo entry tier (LLM-BRIEFING
    // files are monoliths by convention, no banner needed).
    if (repoName !== "(root)") continue;
    if (!rel.startsWith("docs/")) continue;
    if (rel.startsWith("docs/plans/")) continue;
    if (rel.startsWith("docs/audits/")) continue;
    if (rel.startsWith("docs/issues/")) continue;
    if (rel.startsWith("docs/changelogs/")) continue;
    const full = join(repoPath, rel);
    let size: number;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size < SIZE_THRESHOLD) continue;
    if (isDeclaredMonolith(full)) continue;
    violations.push({
      severity: "warning",
      repo: repoName,
      path: rel,
      rule: "undeclared-monolith",
      message: `${(size / 1024).toFixed(0)} KB file has no INTENTIONAL-MONOLITH banner; add one or split`,
    });
  }
  return violations;
}

// --- Runner ---

export async function runLint(opts: LintOpts): Promise<Violation[]> {
  const violations: Violation[] = [];
  const repos = getTargetRepos(opts);

  for (const { name, path, isSubmodule } of repos) {
    violations.push(...checkEntryTier(name, path, isSubmodule));
    violations.push(...checkRootAllowlist(name, path));

    const files = await findMarkdownFiles(path);
    violations.push(...checkNamingConvention(name, path, files));
    violations.push(...checkDatedDirs(name, path, files));
    violations.push(...checkChangelogNames(name, path, files));

    if (!opts.fast) {
      violations.push(...checkStatusHeaders(name, path, files));
      violations.push(...checkMonolithDeclaration(name, path, files));
    }
  }

  return violations;
}
