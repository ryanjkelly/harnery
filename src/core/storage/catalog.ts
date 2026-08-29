import { isAbsolute, relative, resolve } from "node:path";
import { harneryStorageFamilies } from "./builtins.ts";
import type {
  HarneryHostStorageExclusion,
  HarneryHostStorageRegistration,
  HarneryLoggerBinding,
  HarneryRegisteredStorageFamily,
  HarneryStorageContext,
  HarneryStorageFamily,
  HarneryStorageRoot,
} from "./contract.ts";
import { validateFamilyPolicy } from "./policy.ts";

export class HarneryStorageCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarneryStorageCatalogError";
  }
}

export class HarneryStorageCatalog {
  readonly context: HarneryStorageContext;
  readonly families: readonly HarneryRegisteredStorageFamily[];
  readonly logger_bindings: readonly HarneryLoggerBinding[];
  readonly exclusions: readonly HarneryHostStorageExclusion[];
  readonly #byId: ReadonlyMap<string, HarneryRegisteredStorageFamily>;

  constructor(context: HarneryStorageContext, registration: HarneryHostStorageRegistration = {}) {
    if (!context.coord_root || !isAbsolute(context.coord_root)) {
      throw new HarneryStorageCatalogError("storage context coord_root must be absolute");
    }
    if (context.project_root !== undefined && !isAbsolute(context.project_root)) {
      throw new HarneryStorageCatalogError("storage context project_root must be absolute");
    }
    this.context = { ...context, coord_root: resolve(context.coord_root) };
    const sourceFamilies = harneryStorageFamilies();
    const sourceIds = new Set(sourceFamilies.map((family) => family.id));
    const seen = new Set<string>();
    const families = [
      ...sourceFamilies.map((family) => registerFamily(family, "harnery", this.context)),
      ...(registration.families ?? []).map((family) => {
        if (sourceIds.has(family.id)) {
          throw new HarneryStorageCatalogError(
            `host storage family ${family.id} cannot replace or weaken a Harnery descriptor`,
          );
        }
        return registerFamily(family, "host", this.context);
      }),
    ];
    for (const family of families) {
      if (seen.has(family.id)) {
        throw new HarneryStorageCatalogError(`duplicate storage family id: ${family.id}`);
      }
      seen.add(family.id);
    }
    validateRootClaims(families);
    const byId = new Map(families.map((family) => [family.id, family]));
    const bindings = validateBindings(registration.logger_bindings ?? [], byId);
    const exclusions = validateExclusions(registration.exclusions ?? [], families);
    this.families = Object.freeze(families);
    this.logger_bindings = Object.freeze(bindings);
    this.exclusions = Object.freeze(exclusions);
    this.#byId = byId;
  }

  get(familyId: string): HarneryRegisteredStorageFamily | undefined {
    return this.#byId.get(familyId);
  }

  require(familyId: string): HarneryRegisteredStorageFamily {
    const family = this.get(familyId);
    if (!family) throw new HarneryStorageCatalogError(`unknown storage family: ${familyId}`);
    return family;
  }

  familiesForPath(path: string): readonly HarneryRegisteredStorageFamily[] {
    const candidate = resolve(path);
    return this.families.filter((family) =>
      family.resolved_roots.some((root) => rootMatchesPath(root, candidate)),
    );
  }
}

export function createStorageCatalog(
  context: HarneryStorageContext,
  registration: HarneryHostStorageRegistration = {},
): HarneryStorageCatalog {
  return new HarneryStorageCatalog(context, registration);
}

function registerFamily(
  family: HarneryStorageFamily,
  source: "harnery" | "host",
  context: HarneryStorageContext,
): HarneryRegisteredStorageFamily {
  if (!identifier(family.id)) invalid(`storage family id: ${family.id}`);
  if (!nonempty(family.owner)) invalid(`storage family ${family.id} owner`);
  if (
    !new Set([
      "canonical-authority",
      "recovery-state",
      "operational-log",
      "debug-log",
      "durable-object-history",
      "repairable-cache",
      "managed-artifact",
    ]).has(family.storage_class) ||
    !new Set(["canonical-ndjson", "jsonl", "text", "json", "files"]).has(family.format) ||
    !new Set(["private", "internal-metadata", "public"]).has(family.sensitivity) ||
    !new Set(["immutable", "crash-safe", "best-effort", "reconstructable"]).has(
      family.durability,
    ) ||
    !new Set(["single-process", "multi-process", "object-owned"]).has(family.writer_model)
  ) {
    invalid(`storage family ${family.id} descriptor`);
  }
  if (
    !Array.isArray(family.consumers) ||
    family.consumers.length === 0 ||
    family.consumers.some((value) => !nonempty(value)) ||
    new Set(family.consumers).size !== family.consumers.length
  ) {
    invalid(`storage family ${family.id} consumers`);
  }
  validateProvider(family);
  validateFamilyPolicy(family);
  const roots = family.roots(context).map((root) => validateRoot(root, family));
  if (roots.length === 0 && family.provider.inventory !== "delegated") {
    throw new HarneryStorageCatalogError(
      `storage family ${family.id} must resolve at least one root or delegate inventory`,
    );
  }
  if (
    (family.storage_class === "operational-log" || family.storage_class === "debug-log") &&
    family.default_level === undefined
  ) {
    throw new HarneryStorageCatalogError(`log storage family ${family.id} needs a default_level`);
  }
  return deepFreeze({ ...family, source, resolved_roots: roots });
}

function validateProvider(family: HarneryStorageFamily): void {
  const provider = family.provider;
  if (
    !provider ||
    !identifier(provider.provider_id) ||
    !nonempty(provider.lifecycle_authority) ||
    !new Set(["filesystem", "delegated"]).has(provider.kind) ||
    !new Set(["filesystem", "delegated"]).has(provider.inventory) ||
    !new Set(["none", "storage", "delegated"]).has(provider.maintenance)
  ) {
    invalid(`storage family ${family.id} provider`);
  }
  if (
    provider.kind === "delegated" &&
    provider.inventory !== "delegated" &&
    provider.maintenance !== "delegated"
  ) {
    throw new HarneryStorageCatalogError(
      `delegated storage provider ${provider.provider_id} must delegate inventory or maintenance`,
    );
  }
  if (provider.partitions && new Set(provider.partitions).size !== provider.partitions.length) {
    invalid(`storage provider ${provider.provider_id} partitions`);
  }
}

function validateRoot(root: HarneryStorageRoot, family: HarneryStorageFamily): HarneryStorageRoot {
  if (
    !root ||
    !isAbsolute(root.path) ||
    !new Set(["file", "directory"]).has(root.kind) ||
    !new Set(["exact", "subtree", "pattern", "provider-partition"]).has(root.match) ||
    (root.ownership !== undefined && !new Set(["harnery", "host", "external"]).has(root.ownership))
  ) {
    throw new HarneryStorageCatalogError(
      `storage family ${family.id} resolved an invalid root: ${root?.path ?? "(missing)"}`,
    );
  }
  const normalized = { ...root, path: resolve(root.path) };
  if (root.match === "pattern" || root.match === "provider-partition") {
    if (
      !Array.isArray(root.include) ||
      root.include.length === 0 ||
      root.include.some((pattern) => !validRelativePattern(pattern)) ||
      new Set(root.include).size !== root.include.length
    ) {
      throw new HarneryStorageCatalogError(
        `storage family ${family.id} ${root.match} root needs valid include patterns`,
      );
    }
  } else if (root.include !== undefined) {
    throw new HarneryStorageCatalogError(
      `storage family ${family.id} ${root.match} root cannot name include patterns`,
    );
  }
  if (root.match === "provider-partition") {
    if (!identifier(root.partition)) {
      throw new HarneryStorageCatalogError(
        `storage family ${family.id} provider-partition root needs a partition`,
      );
    }
    if (!family.provider.partitions?.includes(root.partition!)) {
      throw new HarneryStorageCatalogError(
        `storage family ${family.id} uses undeclared provider partition ${root.partition}`,
      );
    }
  } else if (root.partition !== undefined) {
    throw new HarneryStorageCatalogError(
      `storage family ${family.id} non-partition root cannot name a partition`,
    );
  }
  return normalized;
}

function validateRootClaims(families: readonly HarneryRegisteredStorageFamily[]): void {
  const claims = families.flatMap((family) =>
    family.resolved_roots.map((root) => ({ family, root })),
  );
  for (let leftIndex = 0; leftIndex < claims.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < claims.length; rightIndex += 1) {
      const left = claims[leftIndex]!;
      const right = claims[rightIndex]!;
      if (left.family.id === right.family.id) continue;
      if (disjointProviderPartitions(left, right)) continue;
      if (rootsOverlap(left.root, right.root)) {
        throw new HarneryStorageCatalogError(
          `overlapping storage roots: ${left.family.id} (${left.root.path}) and ${right.family.id} (${right.root.path})`,
        );
      }
    }
  }
}

function disjointProviderPartitions(
  left: { family: HarneryRegisteredStorageFamily; root: HarneryStorageRoot },
  right: { family: HarneryRegisteredStorageFamily; root: HarneryStorageRoot },
): boolean {
  return (
    left.root.path === right.root.path &&
    left.root.match === "provider-partition" &&
    right.root.match === "provider-partition" &&
    left.family.provider.provider_id === right.family.provider.provider_id &&
    left.root.partition !== right.root.partition &&
    left.root.include!.every((leftPattern) =>
      right.root.include!.every((rightPattern) => !patternsMayOverlap(leftPattern, rightPattern)),
    )
  );
}

function rootsOverlap(left: HarneryStorageRoot, right: HarneryStorageRoot): boolean {
  if (left.path === right.path) {
    if (isPatternRoot(left) && isPatternRoot(right)) {
      return left.include!.some((leftPattern) =>
        right.include!.some((rightPattern) => patternsMayOverlap(leftPattern, rightPattern)),
      );
    }
    return true;
  }
  return contains(left, right.path) || contains(right, left.path);
}

function contains(root: HarneryStorageRoot, candidate: string): boolean {
  if (root.match === "exact") return false;
  const remainder = relative(root.path, candidate);
  if (remainder === "" || remainder.startsWith("..") || isAbsolute(remainder)) return false;
  if (root.match === "subtree") return true;
  return root.include!.some((pattern) => patternCouldContain(pattern, remainder));
}

function rootMatchesPath(root: HarneryStorageRoot, candidate: string): boolean {
  if (root.match === "exact") return root.path === candidate;
  const remainder = relative(root.path, candidate).replaceAll("\\", "/");
  if (remainder === "" || remainder.startsWith("..") || isAbsolute(remainder)) return false;
  if (root.match === "subtree") return true;
  return root.include!.some((pattern) => globRegex(pattern).test(remainder));
}

function isPatternRoot(root: HarneryStorageRoot): boolean {
  return root.match === "pattern" || root.match === "provider-partition";
}

function validRelativePattern(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !value.startsWith("/") &&
    !value.split("/").includes("..") &&
    /^[a-zA-Z0-9._*?/-]+$/.test(value)
  );
}

function globRegex(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`);
}

function patternCouldContain(pattern: string, relativeRoot: string): boolean {
  const literalPrefix = pattern.split(/[?*]/, 1)[0]!;
  return (
    globRegex(pattern).test(relativeRoot) ||
    literalPrefix.startsWith(`${relativeRoot}/`) ||
    relativeRoot.startsWith(literalPrefix)
  );
}

function patternsMayOverlap(left: string, right: string): boolean {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const compared = Math.min(leftSegments.length, rightSegments.length);
  for (let index = 0; index < compared; index += 1) {
    const leftSegment = leftSegments[index]!;
    const rightSegment = rightSegments[index]!;
    if (leftSegment === "**" || rightSegment === "**") return true;
    if (!segmentPatternsMayOverlap(leftSegment, rightSegment)) return false;
  }
  return leftSegments.length === rightSegments.length;
}

function segmentPatternsMayOverlap(left: string, right: string): boolean {
  const leftPrefix = left.split(/[?*]/, 1)[0]!;
  const rightPrefix = right.split(/[?*]/, 1)[0]!;
  if (!leftPrefix.startsWith(rightPrefix) && !rightPrefix.startsWith(leftPrefix)) return false;
  const leftSuffix = left.slice(Math.max(left.lastIndexOf("*"), left.lastIndexOf("?")) + 1);
  const rightSuffix = right.slice(Math.max(right.lastIndexOf("*"), right.lastIndexOf("?")) + 1);
  return leftSuffix.endsWith(rightSuffix) || rightSuffix.endsWith(leftSuffix);
}

function validateBindings(
  bindings: readonly HarneryLoggerBinding[],
  byId: ReadonlyMap<string, HarneryRegisteredStorageFamily>,
): HarneryLoggerBinding[] {
  const seen = new Set<string>();
  return bindings.map((binding) => {
    if (!identifier(binding.component_id)) invalid(`logger component id: ${binding.component_id}`);
    const family = byId.get(binding.family_id);
    if (!family) {
      throw new HarneryStorageCatalogError(
        `logger binding ${binding.component_id} names unknown family ${binding.family_id}`,
      );
    }
    if (family.storage_class !== "operational-log" && family.storage_class !== "debug-log") {
      throw new HarneryStorageCatalogError(
        `logger binding ${binding.component_id} targets non-log family ${binding.family_id}`,
      );
    }
    const key = `${binding.component_id}\0${binding.family_id}`;
    if (seen.has(key)) throw new HarneryStorageCatalogError(`duplicate logger binding: ${key}`);
    seen.add(key);
    return { ...binding };
  });
}

function validateExclusions(
  exclusions: readonly HarneryHostStorageExclusion[],
  families: readonly HarneryRegisteredStorageFamily[],
): HarneryHostStorageExclusion[] {
  return exclusions.map((exclusion) => {
    if (
      !nonempty(exclusion.owner) ||
      !nonempty(exclusion.reason) ||
      !nonempty(exclusion.external_lifecycle_authority)
    ) {
      invalid("host storage exclusion metadata");
    }
    if (exclusion.root.ownership !== "host") {
      throw new HarneryStorageCatalogError("host storage exclusion root must be host-owned");
    }
    const root = validateStandaloneRoot(exclusion.root, "host storage exclusion");
    for (const family of families) {
      for (const claimed of family.resolved_roots) {
        if (rootsOverlap(root, claimed)) {
          throw new HarneryStorageCatalogError(
            `host storage exclusion ${root.path} overlaps registered family ${family.id}`,
          );
        }
      }
    }
    return { ...exclusion, root };
  });
}

function validateStandaloneRoot(root: HarneryStorageRoot, label: string): HarneryStorageRoot {
  if (
    !isAbsolute(root.path) ||
    root.match === "provider-partition" ||
    root.partition !== undefined ||
    root.include !== undefined
  ) {
    throw new HarneryStorageCatalogError(`${label} has an invalid root`);
  }
  return { ...root, path: resolve(root.path) };
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalid(label: string): never {
  throw new HarneryStorageCatalogError(`invalid ${label}`);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
