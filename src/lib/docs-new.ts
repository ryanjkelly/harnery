import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { dump as dumpYaml, JSON_SCHEMA } from "js-yaml";
import type { DocsMetadataType } from "./docs-metadata-v2.ts";
import { validateDocsMetadataV2 } from "./docs-metadata-v2.ts";

export interface DocsNewOpts {
  type: "plan" | "issue" | "handoff" | "runbook" | "topic";
  path: string;
  summary: string;
  owner: string;
  status?: string;
  severity?: string;
  now?: string;
}

export function createDocsFile(repoRoot: string, opts: DocsNewOpts): string {
  const file = resolve(repoRoot, opts.path);
  const relativePath = relative(resolve(repoRoot), file);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error("document path must stay inside the repository");
  }
  if (!file.endsWith(".md")) throw new Error("document path must end in .md");
  if (existsSync(file)) throw new Error(`document already exists: ${opts.path}`);
  const now = opts.now ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const type: DocsMetadataType = opts.type;
  const data: Record<string, unknown> = {
    schema: "harnery-doc/v2",
    type,
    created_at: now,
    updated_at: now,
    owner: opts.owner,
    summary: opts.summary,
  };
  if (type === "plan" || type === "issue" || type === "handoff") {
    data.status = opts.status ?? (type === "plan" ? "proposed" : "open");
    data.status_changed_at = now;
  }
  if (type === "issue") data.severity = opts.severity ?? "medium";
  if (type === "runbook") {
    data.reviewed_at = now;
    const due = new Date(now);
    due.setUTCDate(due.getUTCDate() + 180);
    data.review_due_at = due.toISOString().replace(".000Z", "Z");
  }
  const validation = validateDocsMetadataV2(data);
  if (!validation.valid) {
    throw new Error(
      validation.issues.map((issue) => `${issue.field}: ${issue.message}`).join("; "),
    );
  }
  const yaml = dumpYaml(data, { schema: JSON_SCHEMA, noRefs: true, lineWidth: -1 }).trimEnd();
  const title = opts.path
    .split("/")
    .at(-1)!
    .replace(/\.md$/, "")
    .replace(/^\d{4}-\d{2}-\d{2}_/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `---\n${yaml}\n---\n\n# ${title}\n\n${opts.summary}\n`, "utf8");
  return file;
}
