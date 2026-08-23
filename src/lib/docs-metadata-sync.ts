import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { dump as dumpYaml, JSON_SCHEMA } from "js-yaml";
import { parseFrontmatter } from "./docs-frontmatter.ts";
import { managedDocsMetadataType } from "./docs-metadata-managed.ts";
import { isDocsMetadataV2, validateDocsMetadataV2 } from "./docs-metadata-v2.ts";
import { sh } from "./exec.ts";

let REPO_ROOT = "";
let SUBMODULES: readonly string[] = [];

export function initDocsMetadataSyncContext(opts: {
  repoRoot: string;
  submodules: readonly string[];
}): void {
  REPO_ROOT = opts.repoRoot;
  SUBMODULES = opts.submodules;
}

export interface DocsMetadataSyncOpts {
  repo?: string;
  files?: string[];
  check?: boolean;
  reviewed?: boolean;
  now?: string;
}

export interface DocsMetadataSyncRow {
  repo: string;
  path: string;
  status: "unchanged" | "updated" | "drift" | "invalid";
  fields: string[];
  message?: string;
}

type Target = { name: string; path: string };

function targets(repo?: string): Target[] {
  const all: Target[] = [
    { name: "(root)", path: REPO_ROOT },
    ...SUBMODULES.filter((name) => existsSync(join(REPO_ROOT, name, ".git"))).map((name) => ({
      name,
      path: resolve(REPO_ROOT, name),
    })),
  ];
  const filter = repo === "." ? "(root)" : repo;
  const selected = filter ? all.filter((target) => target.name === filter) : all;
  if (filter && selected.length === 0) throw new Error(`Unknown repository: ${repo}`);
  return selected;
}

async function gitMarkdownPaths(target: Target, command: string): Promise<string[]> {
  const result = await sh(command, { cwd: target.path });
  if (result.exitCode !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.split("\n").filter(Boolean);
}

async function changedFiles(
  target: Target,
  explicit: string[],
  check: boolean,
): Promise<string[]> {
  if (explicit.length > 0) return explicit;
  const staged = await gitMarkdownPaths(
    target,
    "git diff --cached --name-only --diff-filter=ACMR -- '*.md'",
  );
  if (check) return staged;

  const [unstaged, untracked] = await Promise.all([
    gitMarkdownPaths(target, "git diff --name-only --diff-filter=ACMR -- '*.md'"),
    gitMarkdownPaths(target, "git ls-files --others --exclude-standard -- '*.md'"),
  ]);
  return [...new Set([...staged, ...unstaged, ...untracked])];
}

async function headContent(target: Target, path: string): Promise<string | null> {
  const result = await sh(`git show HEAD:${JSON.stringify(path)}`, { cwd: target.path });
  return result.exitCode === 0 ? result.stdout : null;
}

function semanticMetadata(data: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...data };
  delete copy.created_at;
  delete copy.updated_at;
  delete copy.status_changed_at;
  delete copy.reviewed_at;
  delete copy.review_due_at;
  delete copy.source_updated_at;
  delete copy.resolved_at;
  return copy;
}

function semanticChanged(
  before: ReturnType<typeof parseFrontmatter> | null,
  after: ReturnType<typeof parseFrontmatter>,
): boolean {
  if (!before || !isDocsMetadataV2(before.data)) return false;
  return (
    JSON.stringify(semanticMetadata(before.data)) !==
      JSON.stringify(semanticMetadata(after.data)) ||
    before.body.replaceAll("\r\n", "\n").trimEnd() !== after.body.replaceAll("\r\n", "\n").trimEnd()
  );
}

function serialize(data: Record<string, unknown>, body: string): string {
  const yaml = dumpYaml(data, {
    schema: JSON_SCHEMA,
    noRefs: true,
    lineWidth: -1,
    sortKeys: false,
    quotingType: '"',
  }).trimEnd();
  return `---\n${yaml}\n---\n${body.replace(/^\n+/, "\n")}`;
}

function addDays(value: string, days: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().replace(".000Z", "Z");
}

export async function runDocsMetadataSync(
  opts: DocsMetadataSyncOpts,
): Promise<DocsMetadataSyncRow[]> {
  const now = opts.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const rows: DocsMetadataSyncRow[] = [];
  for (const target of targets(opts.repo)) {
    for (const path of await changedFiles(target, opts.files ?? [], opts.check ?? false)) {
      const full = join(target.path, path);
      if (!existsSync(full)) continue;
      const currentText = readFileSync(full, "utf8");
      const current = parseFrontmatter(currentText);
      if (!managedDocsMetadataType(path, current.data, current.raw !== null)) continue;
      if (!isDocsMetadataV2(current.data)) {
        rows.push({
          repo: target.name,
          path,
          status: "invalid",
          fields: [],
          message: "managed document must use harnery-doc/v2",
        });
        continue;
      }
      const beforeText = await headContent(target, path);
      const before = beforeText === null ? null : parseFrontmatter(beforeText);
      const contentChanged = semanticChanged(before, current);
      const beforeV2 = before !== null && isDocsMetadataV2(before.data) ? before.data : null;
      const statusChanged = beforeV2 !== null && beforeV2.status !== current.data.status;
      const fields: string[] = [];
      const expected = { ...current.data };
      if (contentChanged) {
        expected.updated_at = now;
        fields.push("updated_at");
      }
      if (statusChanged) {
        expected.status_changed_at = now;
        fields.push("status_changed_at");
        if (current.data.status === "resolved" && current.data.type === "issue") {
          expected.resolved_at = now;
          fields.push("resolved_at");
        }
      }
      if (
        !statusChanged &&
        beforeV2 &&
        current.data.status_changed_at !== beforeV2.status_changed_at
      ) {
        expected.status_changed_at = beforeV2.status_changed_at;
        fields.push("status_changed_at");
      }
      if (opts.reviewed) {
        if (current.data.type !== "runbook") {
          rows.push({
            repo: target.name,
            path,
            status: "invalid",
            fields: [],
            message: "--reviewed applies only to runbooks",
          });
          continue;
        }
        expected.reviewed_at = now;
        expected.review_due_at = addDays(now, 180);
        expected.updated_at = now;
        fields.push("reviewed_at", "review_due_at", "updated_at");
      }
      if (beforeV2 && expected.created_at !== beforeV2.created_at) {
        rows.push({
          repo: target.name,
          path,
          status: "invalid",
          fields: ["created_at"],
          message: "created_at is immutable",
        });
        continue;
      }
      if (opts.check) {
        const validation = validateDocsMetadataV2(current.data);
        if (!validation.valid) {
          rows.push({
            repo: target.name,
            path,
            status: "invalid",
            fields,
            message: validation.issues
              .map((issue) => `${issue.field}: ${issue.message}`)
              .join("; "),
          });
          continue;
        }
        const drift: string[] = [];
        if (beforeV2 && contentChanged && current.data.updated_at === beforeV2.updated_at) {
          drift.push("updated_at");
        }
        if (beforeV2 && statusChanged) {
          if (current.data.status_changed_at === beforeV2.status_changed_at) {
            drift.push("status_changed_at");
          }
          if (current.data.status_changed_at !== current.data.updated_at) {
            drift.push("status_changed_at");
          }
          if (
            current.data.type === "issue" &&
            current.data.status === "resolved" &&
            current.data.resolved_at !== current.data.status_changed_at
          ) {
            drift.push("resolved_at");
          }
        }
        if (
          beforeV2 &&
          !statusChanged &&
          current.data.status_changed_at !== beforeV2.status_changed_at
        ) {
          drift.push("status_changed_at");
        }
        if (
          opts.reviewed &&
          beforeV2 &&
          (current.data.reviewed_at === beforeV2.reviewed_at ||
            current.data.review_due_at !== addDays(String(current.data.reviewed_at), 180))
        ) {
          drift.push("reviewed_at", "review_due_at");
        }
        const uniqueDrift = [...new Set(drift)];
        rows.push({
          repo: target.name,
          path,
          status: uniqueDrift.length ? "drift" : "unchanged",
          fields: uniqueDrift,
          ...(uniqueDrift.length
            ? { message: `run docs metadata sync for ${uniqueDrift.join(", ")}` }
            : {}),
        });
        continue;
      }
      const validation = validateDocsMetadataV2(expected);
      if (!validation.valid) {
        rows.push({
          repo: target.name,
          path,
          status: "invalid",
          fields,
          message: validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "),
        });
        continue;
      }
      if (fields.length === 0) {
        rows.push({ repo: target.name, path, status: "unchanged", fields: [] });
        continue;
      }
      writeFileSync(full, serialize(expected, current.body), "utf8");
      rows.push({ repo: target.name, path, status: "updated", fields: [...new Set(fields)] });
    }
  }
  return rows;
}
