import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseFrontmatter } from "./docs-frontmatter.ts";
import {
  type DocsMetadataProfile,
  type DocsMetadataValidationIssue,
  isDocsMetadataV2,
  validateDocsMetadataV2,
} from "./docs-metadata-v2.ts";
import { sh } from "./exec.ts";

let REPO_ROOT = "";
let SUBMODULES: readonly string[] = [];

export function initDocsMetadataAuditContext(opts: {
  repoRoot: string;
  submodules: readonly string[];
}): void {
  REPO_ROOT = opts.repoRoot;
  SUBMODULES = opts.submodules;
}

export interface DocsMetadataAuditOpts {
  repo?: string;
  requireV2?: boolean;
}

export type DocsMetadataAuditState = "valid" | "invalid" | "legacy" | "missing";

export interface DocsMetadataAuditRow {
  repo: string;
  path: string;
  state: DocsMetadataAuditState;
  profile: DocsMetadataProfile | null;
  issues: DocsMetadataValidationIssue[];
}

function isInitializedRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function isLifecyclePath(path: string): boolean {
  return (
    path.startsWith("docs/plans/") ||
    path.startsWith("docs/issues/") ||
    path.startsWith("docs/handoffs/")
  );
}

function isRequiredMetadataPath(path: string): boolean {
  return isLifecyclePath(path) || path === "docs/runbook.md";
}

async function trackedMarkdownFiles(repoPath: string): Promise<string[]> {
  const result = await sh('git ls-files --cached "**/*.md" "*.md"', { cwd: repoPath });
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  return result.stdout
    .trim()
    .split("\n")
    .filter((path) => path.endsWith(".md"));
}

function auditFile(
  repoName: string,
  repoPath: string,
  path: string,
  requireV2: boolean,
): DocsMetadataAuditRow | null {
  let content: string;
  try {
    content = readFileSync(join(repoPath, path), "utf8");
  } catch {
    return {
      repo: repoName,
      path: join(repoName === "(root)" ? "" : repoName, path),
      state: "missing",
      profile: null,
      issues: [
        {
          severity: "error",
          code: "file_unreadable",
          field: "",
          message: "metadata file could not be read",
        },
      ],
    };
  }

  const { data, raw } = parseFrontmatter(content);
  const displayPath = join(repoName === "(root)" ? "" : repoName, path);
  if (isDocsMetadataV2(data)) {
    const result = validateDocsMetadataV2(data);
    return {
      repo: repoName,
      path: displayPath,
      state: result.valid ? "valid" : "invalid",
      profile: result.profile,
      issues: result.issues,
    };
  }

  if (!isRequiredMetadataPath(path)) return null;
  const state: DocsMetadataAuditState = raw === null ? "missing" : "legacy";
  return {
    repo: repoName,
    path: displayPath,
    state,
    profile: isLifecyclePath(path) ? "lifecycle" : "runbook",
    issues: [
      {
        severity: requireV2 ? "error" : "warning",
        code: state === "missing" ? "missing_metadata" : "legacy_schema",
        field: "schema",
        message:
          state === "missing"
            ? "required document has no leading YAML metadata"
            : "document still uses pre-v2 metadata",
      },
    ],
  };
}

export async function runDocsMetadataAudit(
  opts: DocsMetadataAuditOpts,
): Promise<DocsMetadataAuditRow[]> {
  const targets = [
    { name: "(root)", path: REPO_ROOT },
    ...SUBMODULES.map((name) => ({ name, path: resolve(REPO_ROOT, name) })).filter((target) =>
      isInitializedRepo(target.path),
    ),
  ];
  const filter = opts.repo === "." ? "(root)" : opts.repo;
  const selected = filter ? targets.filter((target) => target.name === filter) : targets;
  if (filter && selected.length === 0) throw new Error(`Unknown repository: ${opts.repo}`);

  const rows: DocsMetadataAuditRow[] = [];
  for (const target of selected) {
    const files = await trackedMarkdownFiles(target.path);
    for (const path of files) {
      const row = auditFile(target.name, target.path, path, !!opts.requireV2);
      if (row) rows.push(row);
    }
  }

  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export function auditDocsMetadataText(
  content: string,
  path: string,
  requireV2 = false,
): DocsMetadataAuditRow | null {
  const root = resolve("/");
  const parsed = parseFrontmatter(content);
  if (isDocsMetadataV2(parsed.data)) {
    const result = validateDocsMetadataV2(parsed.data);
    return {
      repo: "(root)",
      path: relative(root, resolve(root, path)),
      state: result.valid ? "valid" : "invalid",
      profile: result.profile,
      issues: result.issues,
    };
  }
  if (!isRequiredMetadataPath(path)) return null;
  const state = parsed.raw === null ? "missing" : "legacy";
  return {
    repo: "(root)",
    path,
    state,
    profile: isLifecyclePath(path) ? "lifecycle" : "runbook",
    issues: [
      {
        severity: requireV2 ? "error" : "warning",
        code: state === "missing" ? "missing_metadata" : "legacy_schema",
        field: "schema",
        message:
          state === "missing"
            ? "required document has no leading YAML metadata"
            : "document still uses pre-v2 metadata",
      },
    ],
  };
}
