import { closeSync, read } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { BrowseEntry, BrowseWorkspaces } from "./browse-types";
import { type ListOptions, listDir, resolveDir } from "./file-tree";
import { type ResolveReject, resolveFile, scanChunk } from "./files";

const ARTIFACTS = ".harnery/artifacts";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_WORKSPACES = 500;
const MAX_DELIVERIES = 32;
const catalogCache = new Map<
  string,
  { expires: number; result: Promise<({ ok: true } & BrowseWorkspaces) | ResolveReject> }
>();

function text(value: unknown, max = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  // Metadata is plain text, never markup or an executable URL.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove control bytes from untrusted labels
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return cleaned.trim().slice(0, max) || undefined;
}

/** Read the already-validated descriptor, never reopen a manifest by pathname. */
async function manifest(
  relPath: string,
  opts: ListOptions,
): Promise<Record<string, unknown> | null> {
  const r = resolveFile(relPath, opts);
  if (!r.ok) return null;
  try {
    if (r.size > MAX_MANIFEST_BYTES) return null;
    const buffer = Buffer.alloc(r.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const length = await new Promise<number>((resolve, reject) => {
        read(r.fd, buffer, offset, buffer.length - offset, offset, (err, bytes) =>
          err ? reject(err) : resolve(bytes),
        );
      });
      if (!length) break;
      offset += length;
    }
    if (offset > r.size) return null;
    const bytes = buffer.subarray(0, offset);
    const sniff = scanChunk(bytes);
    if (sniff.binary || sniff.secret) return null;
    const value = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  } finally {
    closeSync(r.fd);
  }
}

function inside(base: string, child: string): boolean {
  return child.startsWith(`${base}/`);
}

/** Only direct managed workspaces get metadata. Manifest-provided paths never
 * establish workspace identity or the containment root. */
export async function workspaceEntry(
  dir: string,
  opts: ListOptions = {},
): Promise<BrowseEntry | undefined> {
  const r = resolveDir(dir, opts);
  if (!r.ok || path.posix.dirname(r.baseRel) !== ARTIFACTS) return undefined;
  const artifact = await manifest(`${r.baseRel}/.harnery-artifact.json`, opts);
  if (
    !artifact ||
    ![1, 2].includes(artifact.schema_version as number) ||
    typeof artifact.artifact_id !== "string"
  )
    return undefined;
  const delivery = await manifest(`${r.baseRel}/.harnery-delivery.json`, opts);
  const validDelivery = delivery?.schema_version === 1 ? delivery : null;
  const owner =
    artifact.created_by && typeof artifact.created_by === "object"
      ? text((artifact.created_by as Record<string, unknown>).name, 80)
      : undefined;
  const entry: BrowseEntry = {
    name: path.posix.basename(r.baseRel),
    relPath: r.baseRel,
    kind: "dir",
    title: text(validDelivery?.title) ?? text(artifact.slug)?.replace(/[-_]+/g, " "),
    purpose: text(artifact.purpose, 1000),
    owner,
    mtime: (await stat(r.real)).mtime.toISOString(),
    deliveryItems: [],
  };
  const seen = new Set<string>();
  for (const item of (Array.isArray(validDelivery?.items) ? validDelivery.items : []).slice(
    0,
    MAX_DELIVERIES,
  )) {
    if (!item || typeof item !== "object" || item.kind !== "path" || typeof item.path !== "string")
      continue;
    const input = item.path;
    if (
      !input ||
      path.posix.isAbsolute(input) ||
      input.includes("\\") ||
      input.startsWith("~") ||
      input.split("/").includes("..")
    )
      continue;
    const candidate = `${r.baseRel}/${input}`;
    const targetDir = resolveDir(candidate, opts);
    let relPath: string;
    let kind: "file" | "dir";
    if (targetDir.ok) {
      relPath = targetDir.baseRel;
      kind = "dir";
    } else {
      const targetFile = resolveFile(candidate, opts);
      if (!targetFile.ok) continue;
      relPath = targetFile.relPath;
      kind = "file";
      closeSync(targetFile.fd);
    }
    if (!inside(r.baseRel, relPath) || seen.has(relPath)) continue;
    seen.add(relPath);
    entry.deliveryItems!.push({
      relPath,
      kind,
      label: text(item.label) ?? path.posix.basename(relPath),
    });
  }
  return entry;
}

async function enrich(entries: BrowseEntry[], opts: ListOptions): Promise<BrowseEntry[]> {
  const result = [...entries];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, entries.length) }, async () => {
      while (cursor < entries.length) {
        const index = cursor++;
        if (entries[index].kind !== "dir") continue;
        try {
          result[index] = (await workspaceEntry(entries[index].relPath, opts)) ?? entries[index];
        } catch {
          /* A disappearing workspace must not fail its siblings. */
        }
      }
    }),
  );
  return result;
}

export async function listBrowseDir(dir: string, opts: ListOptions = {}) {
  const result = listDir(dir, opts);
  if (!result.ok) return result;
  let workspace: BrowseEntry | undefined;
  try {
    workspace = await workspaceEntry(result.dir, opts);
  } catch {
    /* raced away */
  }
  return { ...result, workspace };
}

export async function listWorkspaces(
  opts: ListOptions = {},
): Promise<({ ok: true } & BrowseWorkspaces) | ResolveReject> {
  const resolved = resolveDir(ARTIFACTS, opts);
  if (!resolved.ok)
    return resolved.code === "not_found" ? { ok: true, entries: [], partial: false } : resolved;
  const key = `${resolved.ROOT}\u0000${JSON.stringify(resolved.cfg)}`;
  const cached = catalogCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.result;
  const result = readWorkspaces(opts);
  if (catalogCache.size >= 8) catalogCache.delete(catalogCache.keys().next().value!);
  catalogCache.set(key, { expires: Date.now() + 5_000, result });
  return result;
}

async function readWorkspaces(
  opts: ListOptions,
): Promise<({ ok: true } & BrowseWorkspaces) | ResolveReject> {
  const result = listDir(ARTIFACTS, opts);
  if (!result.ok)
    return result.code === "not_found" ? { ok: true, entries: [], partial: false } : result;
  const directories = result.entries
    .filter((entry) => entry.kind === "dir")
    .sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""));
  const entries = (await enrich(directories.slice(0, MAX_WORKSPACES), opts)).filter(
    (entry) => entry.deliveryItems !== undefined,
  );
  return { ok: true, entries, partial: directories.length > MAX_WORKSPACES };
}
