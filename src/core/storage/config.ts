import { createHash } from "node:crypto";
import { type LogStorageConfigLayerSource, logStorageConfigSource } from "../config.ts";
import {
  HARNERY_STRUCTURED_LOG_PROVIDER_ID,
  type HarneryEffectiveLogRetention,
  type HarneryLogRetentionValueProvenance,
  type HarneryLogStorageDiagnostic,
  type HarneryStorageFamily,
} from "./contract.ts";

export const MIN_LOG_STORAGE_BYTES = 10 * 1024 * 1024;
export const MAX_LOG_STORAGE_BYTES = 1024 * 1024 * 1024 * 1024;
export const MIN_LOG_STORAGE_AGE_DAYS = 1;
export const MAX_LOG_STORAGE_AGE_DAYS = 3_650;

const DAY_MS = 24 * 60 * 60 * 1_000;
const LOG_CLASSES = new Set(["operational-log", "debug-log"]);
const OVERRIDE_FIELDS = new Set(["max_bytes", "max_age_days"]);
const FAMILY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

type ConfigLayer = "user" | "project";
type LogClass = "operational-log" | "debug-log";

interface RetentionOverride {
  max_bytes?: number;
  max_age_days?: number;
}

interface ParsedLayer {
  classes: Map<LogClass, RetentionOverride>;
  families: Map<string, RetentionOverride>;
}

export interface HarneryLogStorageResolution {
  state: "valid" | "invalid";
  families: ReadonlyMap<string, HarneryEffectiveLogRetention>;
  diagnostics: readonly HarneryLogStorageDiagnostic[];
  dormant_user_families: readonly string[];
}

/** Resolve strict, provenance-preserving retention overrides for shared log families. */
export function resolveLogStorageConfiguration(
  coordRoot: string,
  catalogFamilies: readonly HarneryStorageFamily[],
): HarneryLogStorageResolution {
  const candidates = new Map(
    catalogFamilies.filter(isSharedLogFamily).map((family) => [family.id, family] as const),
  );
  const known = new Map(catalogFamilies.map((family) => [family.id, family] as const));
  const diagnostics: HarneryLogStorageDiagnostic[] = [];
  const source = logStorageConfigSource(coordRoot);
  const user = parseLayer(source.layers[0], known, candidates, diagnostics);
  const project = parseLayer(source.layers[1], known, candidates, diagnostics);
  const configInvalid = diagnostics.some(({ code }) => code !== "dormant_user_family");
  const families = new Map<string, HarneryEffectiveLogRetention>();

  for (const family of candidates.values()) {
    const diagnosticCount = diagnostics.length;
    const builtIn = builtInRetention(family, diagnostics);
    const builtInInvalid = diagnostics
      .slice(diagnosticCount)
      .some(({ code }) => code !== "dormant_user_family");
    const effective = resolveFamily(
      family,
      builtIn,
      user,
      project,
      diagnostics,
      configInvalid || builtInInvalid,
    );
    families.set(family.id, effective);
  }

  const invalid = diagnostics.some(({ code }) => code !== "dormant_user_family");

  return {
    state: invalid ? "invalid" : "valid",
    families,
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze(diagnostic))),
    dormant_user_families: Object.freeze(
      diagnostics
        .filter(({ code }) => code === "dormant_user_family")
        .flatMap(({ family_id }) => (family_id ? [family_id] : []))
        .sort(),
    ),
  };
}

/** Apply effective scalars without changing source-owned policy identity or other controls. */
export function withEffectiveLogRetention(
  family: HarneryStorageFamily,
  effective: HarneryEffectiveLogRetention | undefined,
): HarneryStorageFamily {
  if (!effective) return family;
  return {
    ...family,
    policy: {
      ...family.policy,
      retention: {
        ...family.policy.retention,
        status: effective.state === "valid" ? "active" : "inactive",
        max_bytes: { limit: effective.max_bytes, unit: "bytes" },
        max_age: { limit: effective.max_age_ms, unit: "milliseconds" },
        reason:
          effective.state === "valid"
            ? `Effective ${effective.max_age_days}-day and ${effective.max_bytes}-byte storage budget.`
            : "Log retention is inactive because logs.storage configuration is invalid.",
      },
    },
  };
}

function parseLayer(
  source: LogStorageConfigLayerSource,
  known: ReadonlyMap<string, HarneryStorageFamily>,
  candidates: ReadonlyMap<string, HarneryStorageFamily>,
  diagnostics: HarneryLogStorageDiagnostic[],
): ParsedLayer {
  const empty = { classes: new Map<LogClass, RetentionOverride>(), families: new Map() };
  if (source.invalid) {
    diagnostics.push({
      code: "config_file_invalid",
      layer: source.layer,
      message: `${source.layer} configuration file is not valid JSONC`,
    });
    return empty;
  }
  if (source.value === undefined) return empty;
  if (!plainObject(source.value)) {
    diagnostics.push({
      code: "logs_storage_invalid",
      layer: source.layer,
      message: `${source.layer} logs.storage must be an object`,
    });
    return empty;
  }
  for (const key of Object.keys(source.value)) {
    if (key !== "classes" && key !== "families") unknownField(diagnostics, source.layer, key);
  }
  const classes = parseClasses(source.value.classes, source.layer, diagnostics);
  const families = parseFamilies(
    source.value.families,
    source.layer,
    known,
    candidates,
    diagnostics,
  );
  return { classes, families };
}

function parseClasses(
  value: unknown,
  layer: ConfigLayer,
  diagnostics: HarneryLogStorageDiagnostic[],
): Map<LogClass, RetentionOverride> {
  const result = new Map<LogClass, RetentionOverride>();
  if (value === undefined) return result;
  if (!plainObject(value)) {
    diagnostics.push({
      code: "logs_storage_invalid",
      layer,
      field: "classes",
      message: `${layer} logs.storage.classes must be an object`,
    });
    return result;
  }
  for (const [key, override] of Object.entries(value)) {
    if (!LOG_CLASSES.has(key)) {
      diagnostics.push({
        code: "unknown_class",
        layer,
        field: key,
        message: `${layer} logs.storage names unknown class ${key}`,
      });
      continue;
    }
    const parsed = parseOverride(override, layer, `classes.${key}`, diagnostics);
    if (parsed) result.set(key as LogClass, parsed);
  }
  return result;
}

function parseFamilies(
  value: unknown,
  layer: ConfigLayer,
  known: ReadonlyMap<string, HarneryStorageFamily>,
  candidates: ReadonlyMap<string, HarneryStorageFamily>,
  diagnostics: HarneryLogStorageDiagnostic[],
): Map<string, RetentionOverride> {
  const result = new Map<string, RetentionOverride>();
  if (value === undefined) return result;
  if (!plainObject(value)) {
    diagnostics.push({
      code: "logs_storage_invalid",
      layer,
      field: "families",
      message: `${layer} logs.storage.families must be an object`,
    });
    return result;
  }
  for (const [familyId, override] of Object.entries(value)) {
    if (!FAMILY_ID.test(familyId)) {
      diagnostics.push({
        code: layer === "user" ? "logs_storage_invalid" : "unknown_project_family",
        layer,
        family_id: familyId,
        field: `families.${familyId}`,
        message: `${layer} logs.storage family id is invalid: ${familyId}`,
      });
      continue;
    }
    const family = known.get(familyId);
    if (!family) {
      diagnostics.push({
        code: layer === "user" ? "dormant_user_family" : "unknown_project_family",
        layer,
        family_id: familyId,
        message:
          layer === "user"
            ? `user logs.storage family ${familyId} is dormant in this project`
            : `project logs.storage names unknown family ${familyId}`,
      });
      if (layer === "user") {
        parseOverride(override, layer, `families.${familyId}`, diagnostics, familyId);
      }
      continue;
    }
    if (!isLogFamily(family)) {
      diagnostics.push({
        code: "non_log_family",
        layer,
        family_id: familyId,
        message: `${layer} logs.storage family ${familyId} is not a log family`,
      });
      continue;
    }
    if (!candidates.has(familyId)) {
      diagnostics.push({
        code: "unsupported_log_family",
        layer,
        family_id: familyId,
        message: `${layer} logs.storage family ${familyId} does not use shared log segments`,
      });
      continue;
    }
    const parsed = parseOverride(override, layer, `families.${familyId}`, diagnostics, familyId);
    if (parsed) result.set(familyId, parsed);
  }
  return result;
}

function parseOverride(
  value: unknown,
  layer: ConfigLayer,
  path: string,
  diagnostics: HarneryLogStorageDiagnostic[],
  familyId?: string,
): RetentionOverride | null {
  if (!plainObject(value)) {
    diagnostics.push({
      code: "logs_storage_invalid",
      layer,
      ...(familyId ? { family_id: familyId } : {}),
      field: path,
      message: `${layer} logs.storage ${path} must be an object`,
    });
    return null;
  }
  for (const key of Object.keys(value)) {
    if (!OVERRIDE_FIELDS.has(key)) unknownField(diagnostics, layer, `${path}.${key}`, familyId);
  }
  const result: RetentionOverride = {};
  if (value.max_bytes !== undefined) {
    if (!boundedInteger(value.max_bytes, MIN_LOG_STORAGE_BYTES, MAX_LOG_STORAGE_BYTES)) {
      outOfRange(diagnostics, layer, `${path}.max_bytes`, familyId);
    } else result.max_bytes = value.max_bytes;
  }
  if (value.max_age_days !== undefined) {
    if (!boundedInteger(value.max_age_days, MIN_LOG_STORAGE_AGE_DAYS, MAX_LOG_STORAGE_AGE_DAYS)) {
      outOfRange(diagnostics, layer, `${path}.max_age_days`, familyId);
    } else result.max_age_days = value.max_age_days;
  }
  return result;
}

function resolveFamily(
  family: HarneryStorageFamily,
  builtIn: { max_bytes: number; max_age_days: number },
  user: ParsedLayer,
  project: ParsedLayer,
  diagnostics: HarneryLogStorageDiagnostic[],
  invalid: boolean,
): HarneryEffectiveLogRetention {
  let maxBytes = builtIn.max_bytes;
  let maxAgeDays = builtIn.max_age_days;
  let maxBytesSource = builtInSource(family.id);
  let maxAgeSource = builtInSource(family.id);

  const apply = (
    override: RetentionOverride | undefined,
    source: HarneryLogRetentionValueProvenance,
  ) => {
    if (override?.max_bytes !== undefined) {
      maxBytes = override.max_bytes;
      maxBytesSource = source;
    }
    if (override?.max_age_days !== undefined) {
      maxAgeDays = override.max_age_days;
      maxAgeSource = source;
    }
  };

  apply(user.classes.get(family.storage_class as LogClass), {
    source: "user-class",
    selector: family.storage_class,
  });
  apply(project.classes.get(family.storage_class as LogClass), {
    source: "project-class",
    selector: family.storage_class,
  });
  apply(user.families.get(family.id), { source: "user-family", selector: family.id });
  apply(project.families.get(family.id), { source: "project-family", selector: family.id });

  const provenance = { max_bytes: maxBytesSource, max_age_days: maxAgeSource };
  const effectivePolicyFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        schema: "harnery.effective-log-retention/v1",
        family_id: family.id,
        policy_version: family.policy.policy_version,
        max_bytes: maxBytes,
        max_age_days: maxAgeDays,
        provenance,
      }),
    )
    .digest("hex");
  return Object.freeze({
    state: invalid ? "invalid" : "valid",
    max_bytes: maxBytes,
    max_age_days: maxAgeDays,
    max_age_ms: maxAgeDays * DAY_MS,
    effective_policy_fingerprint: effectivePolicyFingerprint,
    provenance: Object.freeze(provenance),
    diagnostics: Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic }))),
  });
}

function builtInRetention(
  family: HarneryStorageFamily,
  diagnostics: HarneryLogStorageDiagnostic[],
): { max_bytes: number; max_age_days: number } {
  const maxBytes = family.policy.retention.max_bytes;
  const maxAge = family.policy.retention.max_age;
  if (
    maxBytes.unit !== "bytes" ||
    !boundedInteger(maxBytes.limit, MIN_LOG_STORAGE_BYTES, MAX_LOG_STORAGE_BYTES) ||
    maxAge.unit !== "milliseconds" ||
    !Number.isSafeInteger(maxAge.limit) ||
    maxAge.limit === null ||
    maxAge.limit % DAY_MS !== 0 ||
    !boundedInteger(maxAge.limit / DAY_MS, MIN_LOG_STORAGE_AGE_DAYS, MAX_LOG_STORAGE_AGE_DAYS)
  ) {
    diagnostics.push({
      code: "logs_storage_invalid",
      family_id: family.id,
      message: `shared log family ${family.id} has invalid source-owned retention defaults`,
    });
    return { max_bytes: MIN_LOG_STORAGE_BYTES, max_age_days: MIN_LOG_STORAGE_AGE_DAYS };
  }
  return { max_bytes: maxBytes.limit, max_age_days: maxAge.limit / DAY_MS };
}

function builtInSource(familyId: string): HarneryLogRetentionValueProvenance {
  return { source: "built-in", selector: familyId };
}

function isLogFamily(family: HarneryStorageFamily): boolean {
  return family.storage_class === "operational-log" || family.storage_class === "debug-log";
}

function isSharedLogFamily(family: HarneryStorageFamily): boolean {
  return isLogFamily(family) && family.provider.provider_id === HARNERY_STRUCTURED_LOG_PROVIDER_ID;
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function unknownField(
  diagnostics: HarneryLogStorageDiagnostic[],
  layer: ConfigLayer,
  field: string,
  familyId?: string,
): void {
  diagnostics.push({
    code: "unknown_field",
    layer,
    ...(familyId ? { family_id: familyId } : {}),
    field,
    message: `${layer} logs.storage contains unknown field ${field}`,
  });
}

function outOfRange(
  diagnostics: HarneryLogStorageDiagnostic[],
  layer: ConfigLayer,
  field: string,
  familyId?: string,
): void {
  diagnostics.push({
    code: "value_out_of_range",
    layer,
    ...(familyId ? { family_id: familyId } : {}),
    field,
    message: `${layer} logs.storage ${field} is outside the supported integer range`,
  });
}
