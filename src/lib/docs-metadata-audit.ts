import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseFrontmatter } from "./docs-frontmatter.ts";
import { isManagedDocsMetadataFile, managedDocsMetadataType } from "./docs-metadata-managed.ts";
import {
  type DocsMetadataProfile,
  type DocsMetadataValidationIssue,
  docsMetadataProfileForType,
  isDocsMetadataV2,
  validateDocsMetadataV2,
} from "./docs-metadata-v2.ts";
import {
  createDocsRepositoryView,
  type DocsRepositorySource,
  type DocsRepositoryView,
} from "./docs-repository-view.ts";

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
  source?: DocsRepositorySource;
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

function auditFile(
  repoName: string,
  path: string,
  content: string | undefined,
): DocsMetadataAuditRow | null {
  if (content === undefined) {
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
  if (!isManagedDocsMetadataFile(path, data, raw !== null)) return null;
  const expectedType = managedDocsMetadataType(path, data, raw !== null);
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

  const state: DocsMetadataAuditState = raw === null ? "missing" : "legacy";
  return {
    repo: repoName,
    path: displayPath,
    state,
    profile: expectedType ? docsMetadataProfileForType(expectedType) : null,
    issues: [
      {
        severity: "error",
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

export async function auditDocsMetadataRepository(
  repoName: string,
  view: DocsRepositoryView,
): Promise<DocsMetadataAuditRow[]> {
  const files = view.trackedPaths.filter((path) => path.endsWith(".md"));
  const texts = await view.readTexts(files);
  return files
    .map((path) => auditFile(repoName, path, texts.get(path)))
    .filter((row): row is DocsMetadataAuditRow => row !== null);
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
    const view = await createDocsRepositoryView(target.path, opts.source ?? "worktree");
    rows.push(...(await auditDocsMetadataRepository(target.name, view)));
  }

  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

export function auditDocsMetadataText(content: string, path: string): DocsMetadataAuditRow | null {
  const root = resolve("/");
  const parsed = parseFrontmatter(content);
  if (!isManagedDocsMetadataFile(path, parsed.data, parsed.raw !== null)) return null;
  const expectedType = managedDocsMetadataType(path, parsed.data, parsed.raw !== null);
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
  const state = parsed.raw === null ? "missing" : "legacy";
  return {
    repo: "(root)",
    path,
    state,
    profile: expectedType ? docsMetadataProfileForType(expectedType) : null,
    issues: [
      {
        severity: "error",
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
