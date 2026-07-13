import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { dump as dumpYaml, JSON_SCHEMA } from "js-yaml";
import { type DocKind, normalizeStatus, parseFrontmatter } from "./docs-frontmatter.ts";

let REPO_ROOT = "";
let SUBMODULES: readonly string[] = [];

export function initDocsMigrationContext(opts: {
  repoRoot: string;
  submodules: readonly string[];
}): void {
  REPO_ROOT = opts.repoRoot;
  SUBMODULES = opts.submodules;
}

export interface FrontmatterMigrationOpts {
  repo?: string;
  apply?: boolean;
}

export type FrontmatterMigrationStatus = "would-update" | "updated" | "skipped" | "error";

export interface FrontmatterMigrationRow {
  repo: string;
  path: string;
  kind: DocKind;
  status: FrontmatterMigrationStatus;
  fields: string[];
  message?: string;
}

export interface FrontmatterConversion {
  status: "convert" | "skipped" | "error";
  content?: string;
  fields: string[];
  message?: string;
}

interface ParsedBoldField {
  index: number;
  label: string;
  value: string;
}

const FIELD_KEYS: Record<string, string> = {
  status: "status",
  date: "date",
  "last updated": "last_updated",
  prerequisites: "prerequisites",
  severity: "severity",
  resolved: "resolved",
  affected: "affected",
  owner: "owner",
  continues: "continues",
  "what you're picking up": "synopsis",
};

const FIELD_ORDER = [
  "status",
  "date",
  "last_updated",
  "status_note",
  "prerequisites",
  "owner",
  "severity",
  "resolved",
  "affected",
  "continues",
  "synopsis",
];

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function openingFields(body: string): ParsedBoldField[] {
  const lines = body.split("\n");
  const fields: ParsedBoldField[] = [];
  for (let index = 0; index < Math.min(lines.length, 40); index++) {
    const line = lines[index]!;
    if (/^##\s+/.test(line) || (index > 0 && /^---\s*$/.test(line))) break;
    const match = line.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
    if (!match) continue;
    const label = normalizeLabel(match[1]!);
    if (!(label in FIELD_KEYS)) continue;
    fields.push({ index, label, value: match[2]!.trim() });
  }
  return fields;
}

function cleanNote(value: string): string {
  let note = value.trim().replace(/^[-–—\s]+/, "");
  if (note.startsWith("(") && note.endsWith(")")) note = note.slice(1, -1);
  return note
    .replace(/\*\*/g, "")
    .replace(/^[*_`]+|[*_`]+$/g, "")
    .trim();
}

function cleanStatusToken(value: string): string {
  return value.trim().replace(/^[*_`]+|[*_`]+$/g, "");
}

function splitStatus(
  raw: string,
  kind: DocKind,
): { status: string; note?: string } | { error: string } {
  const clean = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (!clean) return { error: "empty status value" };

  const separator = clean.match(/\s+[-–—]\s+|\s*\(/);
  if (separator?.index != null) {
    const token = cleanStatusToken(clean.slice(0, separator.index));
    const normalized = normalizeStatus(token, kind);
    if (normalized) {
      const note = cleanNote(clean.slice(separator.index));
      return { status: normalized, ...(note ? { note } : {}) };
    }
  }

  const whole = normalizeStatus(cleanStatusToken(clean), kind);
  if (whole) return { status: whole };

  const words = clean.split(/\s+/);
  for (const count of [1, 2, 3]) {
    if (words.length <= count) continue;
    const token = cleanStatusToken(words.slice(0, count).join(" "));
    const normalized = normalizeStatus(token, kind);
    if (!normalized) continue;
    const note = cleanNote(words.slice(count).join(" "));
    return { status: normalized, ...(note ? { note } : {}) };
  }

  return { error: `unsupported ${kind} status '${raw}'` };
}

function leadingDate(raw: string): { value: string; note?: string } {
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(.*)$/);
  if (!match) return { value: raw };
  const note = cleanNote(match[2]!);
  return { value: match[1]!, ...(note ? { note } : {}) };
}

function serializeFields(fields: Record<string, unknown>): string {
  return FIELD_ORDER.filter((key) => Object.hasOwn(fields, key))
    .map((key) =>
      dumpYaml(
        { [key]: fields[key] },
        {
          schema: JSON_SCHEMA,
          noRefs: true,
          lineWidth: -1,
          sortKeys: false,
        },
      ).trimEnd(),
    )
    .join("\n");
}

function mergeStatusNote(existing: unknown, notes: string[]): string | undefined {
  const parts = [
    ...(typeof existing === "string" && existing.trim() ? [existing.trim()] : []),
    ...notes.filter(Boolean),
  ];
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Convert one lifecycle document without writing it.
 *
 * Only recognized bold fields in the opening block are removed. Narrative
 * labels and bold examples deeper in the body are left byte-for-byte intact.
 */
export function convertLifecycleFrontmatter(content: string, kind: DocKind): FrontmatterConversion {
  const parsed = parseFrontmatter(content);
  if (typeof parsed.data.status === "string" && parsed.data.status.trim()) {
    return {
      status: "skipped",
      fields: [],
      message: "already has YAML status",
    };
  }

  const boldFields = openingFields(parsed.body);
  const statusFields = boldFields.filter((field) => field.label === "status");
  if (statusFields.length === 0) {
    const variant = parsed.body
      .split("\n")
      .slice(0, 40)
      .find((line) => /^\*\*Status\*\*:/i.test(line));
    return {
      status: variant ? "error" : "skipped",
      fields: [],
      message: variant ? `unsupported bold status shape '${variant.trim()}'` : "no opening status",
    };
  }
  if (statusFields.length > 1) {
    return {
      status: "error",
      fields: [],
      message: "multiple opening Status fields",
    };
  }

  const migrated: Record<string, unknown> = {};
  const notes: string[] = [];
  const remove = new Set<number>();

  for (const field of boldFields) {
    const key = FIELD_KEYS[field.label]!;
    let value: unknown = field.value;
    if (key === "status") {
      const split = splitStatus(field.value, kind);
      if ("error" in split) return { status: "error", fields: [], message: split.error };
      value = split.status;
      if (split.note) notes.push(split.note);
    } else if (key === "date" || key === "last_updated" || key === "resolved") {
      const date = leadingDate(field.value);
      value = date.value;
      if (date.note) notes.push(`${key}: ${date.note}`);
    } else if (key === "prerequisites" && field.value.toLowerCase() === "none") {
      value = [];
    }

    if (Object.hasOwn(migrated, key)) {
      return {
        status: "error",
        fields: [],
        message: `multiple opening '${field.label}' fields`,
      };
    }
    if (Object.hasOwn(parsed.data, key)) {
      if (!valuesEqual(parsed.data[key], value)) {
        return {
          status: "error",
          fields: [],
          message: `YAML '${key}' conflicts with bold '${field.label}'`,
        };
      }
    } else {
      migrated[key] = value;
    }
    remove.add(field.index);
  }

  const statusNote = mergeStatusNote(parsed.data.status_note, notes);
  if (notes.length > 0 && Object.hasOwn(parsed.data, "status_note")) {
    return {
      status: "error",
      fields: [],
      message: "YAML 'status_note' conflicts with migrated metadata notes",
    };
  }
  if (statusNote) {
    migrated.status_note = statusNote;
  }

  const body = parsed.body
    .split("\n")
    .filter((_, index) => !remove.has(index))
    .join("\n")
    .replace(/^\n+/, "");

  const newFields = serializeFields(migrated);
  const yaml = parsed.raw ? `${parsed.raw.trimEnd()}\n${newFields}`.trim() : newFields;
  const next = `---\n${yaml}\n---\n\n${body}`;

  return {
    status: "convert",
    content: next,
    fields: Object.keys(migrated),
  };
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkMarkdown(path));
    else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
      files.push(path);
    }
  }
  return files;
}

function lifecycleFiles(repoPath: string): { path: string; kind: DocKind }[] {
  const kinds: { dir: string; kind: DocKind }[] = [
    { dir: "plans", kind: "plan" },
    { dir: "issues", kind: "issue" },
    { dir: "handoffs", kind: "handoff" },
  ];
  return kinds.flatMap(({ dir, kind }) =>
    walkMarkdown(join(repoPath, "docs", dir)).map((path) => ({ path, kind })),
  );
}

function isInitializedRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

function writeAtomic(path: string, content: string): void {
  const temp = join(dirname(path), `.${Date.now()}-${process.pid}.frontmatter.tmp`);
  writeFileSync(temp, content, "utf8");
  renameSync(temp, path);
}

export function runFrontmatterMigration(opts: FrontmatterMigrationOpts): FrontmatterMigrationRow[] {
  const targets = [
    { name: "(root)", path: REPO_ROOT },
    ...SUBMODULES.map((name) => ({ name, path: resolve(REPO_ROOT, name) })).filter((target) =>
      isInitializedRepo(target.path),
    ),
  ];
  const filter = opts.repo === "." ? "(root)" : opts.repo;
  const selected = filter ? targets.filter((target) => target.name === filter) : targets;
  if (filter && selected.length === 0) throw new Error(`Unknown repository: ${opts.repo}`);

  const rows: FrontmatterMigrationRow[] = [];
  const pending: { row: FrontmatterMigrationRow; path: string; content: string }[] = [];
  for (const target of selected) {
    for (const file of lifecycleFiles(target.path)) {
      const displayPath = relative(REPO_ROOT, file.path);
      let content: string;
      try {
        content = readFileSync(file.path, "utf8");
      } catch {
        rows.push({
          repo: target.name,
          path: displayPath,
          kind: file.kind,
          status: "error",
          fields: [],
          message: "unable to read file",
        });
        continue;
      }

      const conversion = convertLifecycleFrontmatter(content, file.kind);
      if (conversion.status === "error" || conversion.status === "skipped") {
        rows.push({
          repo: target.name,
          path: displayPath,
          kind: file.kind,
          status: conversion.status,
          fields: conversion.fields,
          message: conversion.message,
        });
        continue;
      }

      const row: FrontmatterMigrationRow = {
        repo: target.name,
        path: displayPath,
        kind: file.kind,
        status: "would-update",
        fields: conversion.fields,
      };
      rows.push(row);
      pending.push({ row, path: file.path, content: conversion.content! });
    }
  }

  if (opts.apply && !rows.some((row) => row.status === "error")) {
    for (const item of pending) {
      writeAtomic(item.path, item.content);
      item.row.status = "updated";
    }
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
