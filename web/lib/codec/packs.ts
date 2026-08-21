/**
 * Character-pack roster + presentation registry (plan § character asset
 * strategy).
 *
 * Packs are pre-generated image sets on disk under the host's
 * `.harnery/codec/packs/<pack_id>/`; the live view only SELECTS from them,
 * never generates. The registry (`.harnery/codec/registry.json`) is the one
 * durable Codec-owned artifact: immutable historical session→pack bindings
 * plus which bindings are active. It is presentation metadata — Harnery
 * operational code never reads it, and it is never an input to identity,
 * lifecycle, scheduling, or control.
 *
 * A pack is usable only when its manifest validates AND every expression in
 * the supported library has a file on disk; anything less falls back to the
 * neutral letter pack rather than a partial character.
 */

import fs from "node:fs";
import path from "node:path";

import { harneryDir } from "@/lib/coord-reader";

import { type CodecExpression, FALLBACK_PACK } from "./contracts";

export const REQUIRED_EXPRESSIONS: readonly CodecExpression[] = [
  "neutral",
  "focused",
  "curious",
  "deliberating",
  "investigating",
  "building",
  "coordinating",
  "waiting",
  "recovering",
  "celebrating",
  "alert",
];

export interface CodecPack {
  pack_id: string;
  pack_version: string;
  dir: string;
  style?: string;
  character?: string;
  palette?: string;
  generated_with?: string;
  quality?: string;
  /** expression → filename (validated present on disk). */
  expressions: Record<string, string>;
}

export interface PackBinding {
  instance_id: string;
  pack_id: string;
  pack_version: string;
  bound_at: string;
  released_at?: string;
}

export interface PackRegistry {
  schema_version: 1;
  bindings: PackBinding[];
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function codecDir(root = harneryDir()): string {
  return path.join(root, "codec");
}

export function packsDir(root = harneryDir()): string {
  return path.join(codecDir(root), "packs");
}

function registryPath(root = harneryDir()): string {
  return path.join(codecDir(root), "registry.json");
}

/** Validate one pack directory; returns the pack or the missing pieces. */
export function validatePackDir(
  dir: string,
): { ok: true; pack: CodecPack } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf8"));
  } catch (err) {
    return { ok: false, problems: [`unreadable pack.json: ${(err as Error).message}`] };
  }
  if (manifest.schema_version !== 1) problems.push("unsupported schema_version");
  const packId = typeof manifest.pack_id === "string" ? manifest.pack_id : "";
  const packVersion = typeof manifest.pack_version === "string" ? manifest.pack_version : "";
  if (!SLUG_RE.test(packId)) problems.push("invalid pack_id");
  if (!packVersion) problems.push("missing pack_version");
  if (packId && path.basename(dir) !== packId) problems.push("pack_id does not match directory");

  const expressions =
    typeof manifest.expressions === "object" && manifest.expressions !== null
      ? (manifest.expressions as Record<string, unknown>)
      : {};
  const validated: Record<string, string> = {};
  for (const expr of REQUIRED_EXPRESSIONS) {
    const file = expressions[expr];
    if (typeof file !== "string" || !FILE_RE.test(file) || file.includes("..")) {
      problems.push(`expression ${expr}: missing or invalid filename`);
      continue;
    }
    if (!fs.existsSync(path.join(dir, file))) {
      problems.push(`expression ${expr}: file ${file} not on disk`);
      continue;
    }
    validated[expr] = file;
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    pack: {
      pack_id: packId,
      pack_version: packVersion,
      dir,
      expressions: validated,
      ...(typeof manifest.style === "string" ? { style: manifest.style } : {}),
      ...(typeof manifest.character === "string" ? { character: manifest.character } : {}),
      ...(typeof manifest.palette === "string" ? { palette: manifest.palette } : {}),
      ...(typeof manifest.generated_with === "string"
        ? { generated_with: manifest.generated_with }
        : {}),
      ...(typeof manifest.quality === "string" ? { quality: manifest.quality } : {}),
    },
  };
}

/** Every complete pack in the roster, sorted by id for stable allocation. */
export function listPacks(root = harneryDir()): CodecPack[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(packsDir(root));
  } catch {
    return []; // no roster yet: everyone gets the fallback pack
  }
  const packs: CodecPack[] = [];
  for (const entry of entries.sort()) {
    const dir = path.join(packsDir(root), entry);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const result = validatePackDir(dir);
    if (result.ok) packs.push(result.pack);
  }
  return packs;
}

export function readPackRegistry(root = harneryDir()): PackRegistry {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(root), "utf8"));
    if (parsed?.schema_version === 1 && Array.isArray(parsed.bindings)) {
      return parsed as PackRegistry;
    }
  } catch {
    // fall through to a fresh registry
  }
  return { schema_version: 1, bindings: [] };
}

function writeRegistry(root: string, registry: PackRegistry): void {
  const target = registryPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 1)}\n`);
  fs.renameSync(tmp, target);
}

/**
 * Assign one unique pack per live instance, releasing bindings whose
 * instances are gone so their packs return to the pool. Historical bindings
 * are never rewritten — a release only stamps `released_at`. When the roster
 * runs short the fallback pack covers the shortage without being bound.
 */
export function allocateCharacters(
  instanceIds: readonly string[],
  now: string,
  root = harneryDir(),
): Map<string, { pack_id: string; pack_version: string }> {
  const packs = listPacks(root);
  const registry = readPackRegistry(root);
  const live = new Set(instanceIds);
  const byId = new Map(packs.map((p) => [p.pack_id, p]));
  let changed = false;

  const activeByInstance = new Map<string, PackBinding>();
  const upgradedPackByInstance = new Map<string, string>();
  const packInUse = new Set<string>();
  for (const binding of registry.bindings) {
    if (binding.released_at) continue;
    if (!live.has(binding.instance_id)) {
      binding.released_at = now;
      changed = true;
      continue;
    }
    const currentPack = byId.get(binding.pack_id);
    if (currentPack && currentPack.pack_version !== binding.pack_version) {
      // Pack upgrades preserve the historical binding and immediately rebind
      // the live instance below so the asset URL gets the new cache key.
      binding.released_at = now;
      upgradedPackByInstance.set(binding.instance_id, binding.pack_id);
      changed = true;
      continue;
    }
    // An active binding to a pack that vanished from disk stays recorded for
    // history but cannot render; the panel falls back below.
    activeByInstance.set(binding.instance_id, binding);
    packInUse.add(binding.pack_id);
  }

  const out = new Map<string, { pack_id: string; pack_version: string }>();
  const freePacks = packs.filter((p) => !packInUse.has(p.pack_id));

  for (const instanceId of instanceIds) {
    const existing = activeByInstance.get(instanceId);
    if (existing && byId.has(existing.pack_id)) {
      out.set(instanceId, { pack_id: existing.pack_id, pack_version: existing.pack_version });
      continue;
    }
    const upgradedPackId = upgradedPackByInstance.get(instanceId);
    const upgradedPackIndex = upgradedPackId
      ? freePacks.findIndex((candidate) => candidate.pack_id === upgradedPackId)
      : -1;
    const pack =
      upgradedPackIndex >= 0 ? freePacks.splice(upgradedPackIndex, 1)[0] : freePacks.shift();
    if (!pack) {
      out.set(instanceId, { ...FALLBACK_PACK });
      continue;
    }
    registry.bindings.push({
      instance_id: instanceId,
      pack_id: pack.pack_id,
      pack_version: pack.pack_version,
      bound_at: now,
    });
    packInUse.add(pack.pack_id);
    out.set(instanceId, { pack_id: pack.pack_id, pack_version: pack.pack_version });
    changed = true;
  }

  if (changed) {
    try {
      writeRegistry(root, registry);
    } catch {
      // Presentation metadata only: failing to persist must never take the
      // scene down. The same allocation re-derives next build.
    }
  }
  return out;
}

/** Resolve one expression image for the asset route. Null = not servable. */
export function resolvePackAsset(
  packId: string,
  expression: string,
  root = harneryDir(),
): { filePath: string; contentType: string } | null {
  if (!SLUG_RE.test(packId) || !SLUG_RE.test(expression)) return null;
  const dir = path.join(packsDir(root), packId);
  const result = validatePackDir(dir);
  if (!result.ok) return null;
  const file = result.pack.expressions[expression] ?? result.pack.expressions.neutral;
  if (!file) return null;
  const filePath = path.join(dir, file);
  const ext = path.extname(file).toLowerCase();
  const contentType =
    ext === ".webp"
      ? "image/webp"
      : ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : null;
  if (!contentType) return null;
  return { filePath, contentType };
}
