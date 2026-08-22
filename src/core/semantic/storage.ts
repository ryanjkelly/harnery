import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { canonicalJsonV3, sha256V3 } from "../events/v3/canonical.ts";
import type { LedgerCursorV3 } from "../events/v3/reader.ts";
import {
  SEMANTIC_EVIDENCE_CONTRACT_VERSION,
  SEMANTIC_PROMPT_CONTRACT_VERSION,
  type SemanticAgentReadModelV1,
  type SemanticConfiguredModel,
  type SemanticHarness,
} from "./contract.ts";
import { validateSemanticReadModel } from "./validate.ts";

export const SEMANTIC_MANIFEST_SCHEMA_VERSION = 1 as const;
const MAX_JSON_BYTES = 512 * 1024;
const MAX_CACHE_FILES = 500;
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface SemanticReaderResolution {
  harness: SemanticHarness;
  configured_model: SemanticConfiguredModel;
  resolved_model_id?: string;
  model_attestation?: "verified" | "requested-only";
  available: boolean;
  reason_code?:
    | "harness_unavailable"
    | "authentication_unavailable"
    | "model_unavailable"
    | "model_mismatch";
  discovered_at: string;
}

export interface SemanticPendingItem {
  generation_id: string;
  evidence_digest: `sha256:${string}`;
  band: 1 | 2;
  pending_since: string;
}

export interface SemanticCallReceipt {
  generation_id: string;
  started_at: string;
}

export interface SemanticManifestV1 {
  schema_version: typeof SEMANTIC_MANIFEST_SCHEMA_VERSION;
  ledger_genesis_id: string;
  cursor?: LedgerCursorV3;
  configuration_digest: `sha256:${string}`;
  evidence_contract_version: typeof SEMANTIC_EVIDENCE_CONTRACT_VERSION;
  prompt_contract_version: typeof SEMANTIC_PROMPT_CONTRACT_VERSION;
  adapter_resolutions: Partial<Record<SemanticHarness, SemanticReaderResolution>>;
  pending: SemanticPendingItem[];
  call_history: SemanticCallReceipt[];
  last_first_band_generation_id?: string;
  newest_successful_pass?: string;
  updated_at: string;
}

export interface SemanticCacheIdentity {
  evidence_digest: `sha256:${string}`;
  source_harness: SemanticHarness;
  configured_model: SemanticConfiguredModel;
  resolved_model_id: string;
  evidence_contract_version: number;
  prompt_contract_version: number;
}

export function semanticPaths(coordRootRaw: string) {
  const root = join(resolve(coordRootRaw), ".harnery", "semantic", "v1");
  return {
    root,
    manifest: join(root, "manifest.json"),
    agents: join(root, "agents"),
    cache: join(root, "cache"),
    service: join(root, "service.json"),
    stop: join(root, "stop.json"),
    lease: join(root, "lease.json"),
    log: join(root, "service.log"),
  };
}

export function semanticConfigurationDigest(
  resolutions: Partial<Record<SemanticHarness, SemanticReaderResolution>>,
): `sha256:${string}` {
  const stable = Object.fromEntries(
    Object.entries(resolutions)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([harness, resolution]) => [
        harness,
        resolution
          ? {
              configured_model: resolution.configured_model,
              ...(resolution.resolved_model_id
                ? { resolved_model_id: resolution.resolved_model_id }
                : {}),
              ...(resolution.model_attestation
                ? { model_attestation: resolution.model_attestation }
                : {}),
              available: resolution.available,
              ...(resolution.reason_code ? { reason_code: resolution.reason_code } : {}),
            }
          : null,
      ]),
  );
  return sha256V3(canonicalJsonV3(stable));
}

export function semanticCacheKey(identity: SemanticCacheIdentity): `sha256:${string}` {
  return sha256V3(canonicalJsonV3(identity));
}

export function readSemanticManifest(coordRootRaw: string): SemanticManifestV1 | undefined {
  const path = semanticPaths(coordRootRaw).manifest;
  if (!existsSync(path)) return undefined;
  const value = readBoundedJson<SemanticManifestV1>(path, "semantic manifest");
  if (
    value.schema_version !== SEMANTIC_MANIFEST_SCHEMA_VERSION ||
    value.evidence_contract_version !== SEMANTIC_EVIDENCE_CONTRACT_VERSION ||
    value.prompt_contract_version !== SEMANTIC_PROMPT_CONTRACT_VERSION ||
    !Array.isArray(value.pending) ||
    !Array.isArray(value.call_history)
  ) {
    throw new Error("semantic manifest has an unsupported schema");
  }
  return value;
}

export function writeSemanticManifest(coordRootRaw: string, manifest: SemanticManifestV1): void {
  writePrivateJsonAtomic(semanticPaths(coordRootRaw).manifest, manifest);
}

export function readSemanticAgentDocument(
  coordRootRaw: string,
  generationId: string,
): SemanticAgentReadModelV1 | undefined {
  requireGenerationId(generationId);
  const path = join(semanticPaths(coordRootRaw).agents, `${generationId}.json`);
  if (!existsSync(path)) return undefined;
  const value = readBoundedJson<unknown>(path, "semantic agent document");
  const verdict = validateSemanticReadModel(value);
  if (!verdict.ok)
    throw new Error(`semantic agent document is invalid: ${verdict.issues.join(",")}`);
  return verdict.value;
}

export function listSemanticAgentDocuments(coordRootRaw: string): SemanticAgentReadModelV1[] {
  const dir = semanticPaths(coordRootRaw).agents;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^gen_[a-zA-Z0-9-]+\.json$/.test(name))
    .sort()
    .flatMap((name) => {
      try {
        const value = readBoundedJson<unknown>(join(dir, name), "semantic agent document");
        const verdict = validateSemanticReadModel(value);
        return verdict.ok ? [verdict.value] : [];
      } catch {
        return [];
      }
    });
}

export function inspectSemanticDocument(
  coordRootRaw: string,
  instanceOrGeneration: string,
): SemanticAgentReadModelV1 | undefined {
  if (instanceOrGeneration.startsWith("gen_")) {
    return readSemanticAgentDocument(coordRootRaw, instanceOrGeneration);
  }
  return listSemanticAgentDocuments(coordRootRaw)
    .filter((document) => document.instance_id === instanceOrGeneration)
    .sort((left, right) => right.generated_at.localeCompare(left.generated_at))[0];
}

export function writeSemanticAgentDocument(
  coordRootRaw: string,
  document: SemanticAgentReadModelV1,
): void {
  const verdict = validateSemanticReadModel(document);
  if (!verdict.ok)
    throw new Error(`refusing invalid semantic document: ${verdict.issues.join(",")}`);
  writePrivateJsonAtomic(
    join(semanticPaths(coordRootRaw).agents, `${document.generation_id}.json`),
    document,
  );
}

export function readSemanticCache(
  coordRootRaw: string,
  cacheKey: string,
): SemanticAgentReadModelV1 | undefined {
  requireDigest(cacheKey);
  const path = join(semanticPaths(coordRootRaw).cache, `${cacheKey.slice("sha256:".length)}.json`);
  if (!existsSync(path)) return undefined;
  const value = readBoundedJson<unknown>(path, "semantic cache entry");
  const verdict = validateSemanticReadModel(value);
  return verdict.ok && verdict.value.reader_outcome === "accepted" ? verdict.value : undefined;
}

export function writeSemanticCache(
  coordRootRaw: string,
  cacheKey: string,
  document: SemanticAgentReadModelV1,
): void {
  requireDigest(cacheKey);
  if (document.reader_outcome !== "accepted") {
    throw new Error("only accepted semantic documents may enter the cache");
  }
  writePrivateJsonAtomic(
    join(semanticPaths(coordRootRaw).cache, `${cacheKey.slice("sha256:".length)}.json`),
    document,
  );
}

export function invalidateSemanticDerivedState(coordRootRaw: string): void {
  const paths = semanticPaths(coordRootRaw);
  rmSync(paths.agents, { recursive: true, force: true });
  rmSync(paths.cache, { recursive: true, force: true });
  rmSync(paths.manifest, { force: true });
}

export function pruneSemanticStorage(
  coordRootRaw: string,
  options: { keepGenerations: ReadonlySet<string>; now?: number; maxCacheFiles?: number },
): void {
  const paths = semanticPaths(coordRootRaw);
  if (existsSync(paths.agents)) {
    for (const name of readdirSync(paths.agents)) {
      const generationId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (generationId && !options.keepGenerations.has(generationId)) {
        rmSync(join(paths.agents, name), { force: true });
      }
    }
  }
  if (!existsSync(paths.cache)) return;
  const now = options.now ?? Date.now();
  const maxFiles = Math.min(MAX_CACHE_FILES, Math.max(1, options.maxCacheFiles ?? MAX_CACHE_FILES));
  const entries = readdirSync(paths.cache)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .map((name) => ({ name, mtime: statSync(join(paths.cache, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime);
  for (const [index, entry] of entries.entries()) {
    if (index >= maxFiles || now - entry.mtime > MAX_CACHE_AGE_MS) {
      rmSync(join(paths.cache, entry.name), { force: true });
    }
  }
}

function requireGenerationId(value: string): void {
  if (!/^gen_[0-9a-zA-Z-]{1,128}$/.test(value)) throw new Error("invalid semantic generation id");
}

function requireDigest(value: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("invalid semantic cache key");
}

function readBoundedJson<T>(path: string, label: string): T {
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_JSON_BYTES) throw new Error(`${label} has invalid size ${size}`);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writePrivateJsonAtomic(path: string, value: unknown): void {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(body) > MAX_JSON_BYTES) {
    throw new Error(`semantic file exceeds ${MAX_JSON_BYTES} bytes`);
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}
