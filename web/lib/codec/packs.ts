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
import { COORD_NAMES } from "../../../src/core/agents/state/names";

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

/**
 * Extended tier: expressions a pack MAY ship. Optional by design — a pack
 * missing one renders its EXPRESSION_FALLBACK parent, so extended art lands
 * incrementally (52 images per expression) without invalidating any pack.
 */
export const EXTENDED_EXPRESSIONS: readonly CodecExpression[] = [
  "observing",
  "wrapping-up",
  "compacting",
  "conducting",
  "weighing",
  "planning",
  "verifying",
  "strained",
  "blocked",
  "dormant",
];

export const ROSTER_EXPRESSIONS: readonly CodecExpression[] = [
  ...REQUIRED_EXPRESSIONS,
  ...EXTENDED_EXPRESSIONS,
];

/** Extended expression → the required base expression that stands in for it. */
export const EXPRESSION_FALLBACK: Readonly<Partial<Record<CodecExpression, CodecExpression>>> = {
  observing: "investigating",
  "wrapping-up": "celebrating",
  compacting: "recovering",
  conducting: "coordinating",
  weighing: "deliberating",
  planning: "deliberating",
  verifying: "focused",
  strained: "focused",
  blocked: "waiting",
  dormant: "waiting",
};

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

export interface CharacterAllocationTarget {
  instance_id: string;
  display_name?: string;
}

export interface CodecRosterSummary {
  active_bindings: PackBinding[];
  released_bindings: PackBinding[];
  reserve_pack_ids: string[];
  orphaned_bindings: PackBinding[];
  historical_uses_by_pack: Record<string, number>;
  coverage: "ready" | "at-capacity" | "attention";
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_VALIDATION_CACHE_ENTRIES = 128;

type ValidPackResult = { ok: true; pack: CodecPack };

const validationCache = new Map<string, { manifestJson: string; result: ValidPackResult }>();

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
  const manifestPath = path.join(dir, "pack.json");
  let manifestJson: string;
  try {
    manifestJson = fs.readFileSync(manifestPath, "utf8");
  } catch (err) {
    return { ok: false, problems: [`unreadable pack.json: ${(err as Error).message}`] };
  }

  const cached = validationCache.get(dir);
  if (cached?.manifestJson === manifestJson) {
    validationCache.delete(dir);
    validationCache.set(dir, cached);
    return cached.result;
  }

  const problems: string[] = [];
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestJson);
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
  for (const expr of EXTENDED_EXPRESSIONS) {
    const file = expressions[expr];
    if (file === undefined) continue; // extended entries are optional
    if (typeof file !== "string" || !FILE_RE.test(file) || file.includes("..")) {
      problems.push(`expression ${expr}: declared but invalid filename`);
      continue;
    }
    if (!fs.existsSync(path.join(dir, file))) {
      problems.push(`expression ${expr}: file ${file} not on disk`);
      continue;
    }
    validated[expr] = file;
  }
  if (problems.length > 0) return { ok: false, problems };
  const result: ValidPackResult = {
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
  validationCache.set(dir, { manifestJson, result });
  if (validationCache.size > MAX_VALIDATION_CACHE_ENTRIES) {
    const oldest = validationCache.keys().next().value;
    if (oldest !== undefined) validationCache.delete(oldest);
  }
  return result;
}

/** Every complete pack in stable character-sequence order. */
export function listPacks(root = harneryDir()): CodecPack[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(packsDir(root));
  } catch {
    return []; // no roster yet: everyone gets the fallback pack
  }
  const packs: CodecPack[] = [];
  for (const entry of entries.sort(comparePackIds)) {
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

function comparePackIds(left: string, right: string): number {
  const leftOrdinal = packOrdinal(left);
  const rightOrdinal = packOrdinal(right);
  if (leftOrdinal !== null && rightOrdinal !== null && leftOrdinal !== rightOrdinal) {
    return leftOrdinal - rightOrdinal;
  }
  if (leftOrdinal !== null && rightOrdinal === null) return -1;
  if (leftOrdinal === null && rightOrdinal !== null) return 1;
  return left.localeCompare(right, "en", { numeric: true });
}

function packOrdinal(packId: string): number | null {
  const match = /^[fm](\d+)-/.exec(packId);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

type CharacterGender = "female" | "male";

function packGender(packId: string): CharacterGender | null {
  if (/^f\d+-/.test(packId)) return "female";
  if (/^m\d+-/.test(packId)) return "male";
  return null;
}

function nameGender(displayName: string | undefined): CharacterGender | null {
  if (!displayName) return null;
  const index = COORD_NAMES.findIndex((name) => name === displayName);
  if (index < 0) return null;
  const startsFemale = Math.floor(index / 26) % 2 === 0;
  const evenLetter = (index % 26) % 2 === 0;
  return startsFemale === evenLetter ? "female" : "male";
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

/** Read-only operational rollup for the roster lab. */
export function summarizePackRoster(
  packs: readonly CodecPack[],
  registry: PackRegistry,
): CodecRosterSummary {
  const byId = new Map(packs.map((pack) => [pack.pack_id, pack]));
  const activeBindings = registry.bindings.filter((binding) => !binding.released_at);
  const releasedBindings = registry.bindings.filter((binding) => Boolean(binding.released_at));
  const orphanedBindings = activeBindings.filter((binding) => {
    const pack = byId.get(binding.pack_id);
    return !pack || pack.pack_version !== binding.pack_version;
  });
  const healthyAssigned = new Set(
    activeBindings
      .filter((binding) => !orphanedBindings.includes(binding))
      .map((binding) => binding.pack_id),
  );
  const reservePackIds = packs
    .map((pack) => pack.pack_id)
    .filter((packId) => !healthyAssigned.has(packId));
  const historicalUsesByPack: Record<string, number> = {};
  for (const binding of registry.bindings) {
    historicalUsesByPack[binding.pack_id] = (historicalUsesByPack[binding.pack_id] ?? 0) + 1;
  }

  return {
    active_bindings: activeBindings,
    released_bindings: releasedBindings,
    reserve_pack_ids: reservePackIds,
    orphaned_bindings: orphanedBindings,
    historical_uses_by_pack: historicalUsesByPack,
    coverage:
      orphanedBindings.length > 0
        ? "attention"
        : reservePackIds.length > 0
          ? "ready"
          : "at-capacity",
  };
}

function writeRegistry(root: string, registry: PackRegistry): void {
  const target = registryPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(registry, null, 1)}\n`);
  fs.renameSync(tmp, target);
}

/**
 * Assign one unique pack per visible instance, releasing bindings whose
 * instances are gone so their packs return to the pool. Historical bindings
 * are never rewritten — a release only stamps `released_at`. When the roster
 * runs short, overflow instances reuse a deterministic pack without creating
 * a binding. That keeps a character portrait on every card while preserving
 * unique, durable identities whenever roster capacity allows.
 */
export function allocateCharacters(
  targets: readonly CharacterAllocationTarget[],
  now: string,
  root = harneryDir(),
): Map<string, { pack_id: string; pack_version: string }> {
  const packs = listPacks(root);
  const registry = readPackRegistry(root);
  const instanceIds = targets.map((target) => target.instance_id);
  const live = new Set(instanceIds);
  const desiredGender = new Map(
    targets.map((target) => [target.instance_id, nameGender(target.display_name)]),
  );
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
    const expectedGender = desiredGender.get(binding.instance_id);
    const currentGender = packGender(binding.pack_id);
    if (expectedGender && currentGender && expectedGender !== currentGender) {
      // The original allocator consumed lexical pack ids, which exhausted all
      // f-prefixed packs before reaching m-prefixed packs. Preserve that
      // history, but release the wrong live portrait so it can be corrected.
      binding.released_at = now;
      changed = true;
      continue;
    }
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

  for (const target of targets) {
    const instanceId = target.instance_id;
    const existing = activeByInstance.get(instanceId);
    if (existing && byId.has(existing.pack_id)) {
      out.set(instanceId, { pack_id: existing.pack_id, pack_version: existing.pack_version });
      continue;
    }
    const upgradedPackId = upgradedPackByInstance.get(instanceId);
    const upgradedPackIndex = upgradedPackId
      ? freePacks.findIndex((candidate) => candidate.pack_id === upgradedPackId)
      : -1;
    const expectedGender = desiredGender.get(instanceId);
    const genderPackIndex = expectedGender
      ? freePacks.findIndex((candidate) => packGender(candidate.pack_id) === expectedGender)
      : -1;
    const packIndex = upgradedPackIndex >= 0 ? upgradedPackIndex : genderPackIndex;
    const pack = packIndex >= 0 ? freePacks.splice(packIndex, 1)[0] : freePacks.shift();
    if (!pack) {
      const overflowPacks = expectedGender
        ? packs.filter((candidate) => packGender(candidate.pack_id) === expectedGender)
        : packs;
      const fallbackOverflowPacks = overflowPacks.length > 0 ? overflowPacks : packs;
      const overflowPack =
        fallbackOverflowPacks[stablePackIndex(instanceId, fallbackOverflowPacks.length)];
      out.set(
        instanceId,
        overflowPack
          ? { pack_id: overflowPack.pack_id, pack_version: overflowPack.pack_version }
          : { ...FALLBACK_PACK },
      );
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

function stablePackIndex(instanceId: string, packCount: number): number {
  if (packCount === 0) return 0;
  let hash = 2_166_136_261;
  for (let index = 0; index < instanceId.length; index += 1) {
    hash ^= instanceId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % packCount;
}

/** Resolve one expression image for the asset route. Null = not servable. */
export function resolvePackAsset(
  packId: string,
  expression: string,
  root = harneryDir(),
): { filePath: string; contentType: string; packVersion: string } | null {
  if (!SLUG_RE.test(packId) || !SLUG_RE.test(expression)) return null;
  const dir = path.join(packsDir(root), packId);
  const result = validatePackDir(dir);
  if (!result.ok) return null;
  const file = resolveExpressionFile(result.pack, expression);
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
  return { filePath, contentType, packVersion: result.pack.pack_version };
}

function resolveExpressionFile(pack: CodecPack, expression: string): string | undefined {
  const fallback = EXPRESSION_FALLBACK[expression as CodecExpression];
  return (
    pack.expressions[expression] ??
    (fallback ? pack.expressions[fallback] : undefined) ??
    pack.expressions.neutral
  );
}
