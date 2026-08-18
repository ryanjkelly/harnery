import { createHash, createHmac, hkdfSync } from "node:crypto";

export const EVENT_V3_CANONICALIZER = "harnery-jcs-nfc-v1" as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/**
 * Canonical JSON used for V3 contract digests, event bytes, and fingerprints.
 *
 * It follows RFC 8785's ECMAScript number and string serialization, adds the
 * V3 NFC rule for keys and values, and rejects values that JSON would silently
 * erase or reinterpret. Object keys are serialized directly instead of via an
 * intermediate object so integer-looking keys remain in lexical order.
 */
export function canonicalJsonV3(value: unknown): string {
  return serialize(value, new Set<object>());
}

export function sha256V3(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export interface FingerprintV3 {
  algorithm: "hmac-sha256";
  canonicalizer: typeof EVENT_V3_CANONICALIZER;
  key_epoch: `pep_${string}`;
  scope: "generation" | "root";
  digest: `sha256:${string}`;
}

export interface FingerprintContextV3 {
  epochId: `pep_${string}`;
  epochKey: Uint8Array;
  rootId: `root_${string}`;
  generationId?: `gen_${string}`;
}

export function fingerprintV3(
  context: FingerprintContextV3,
  domain: string,
  value: unknown,
  scope: "generation" | "root" = "generation",
): FingerprintV3 {
  assertDomain(domain);
  const rootKey = Buffer.from(
    hkdfSync(
      "sha256",
      context.epochKey,
      Buffer.from(context.epochId, "utf8"),
      Buffer.from(`harnery:v3:root\0${context.rootId}`, "utf8"),
      32,
    ),
  );
  let comparisonKey = rootKey;
  if (scope === "generation") {
    if (!context.generationId) {
      throw new Error("generation-scoped fingerprint requires a generation ID");
    }
    comparisonKey = Buffer.from(
      hkdfSync(
        "sha256",
        rootKey,
        Buffer.from(context.generationId, "utf8"),
        Buffer.from("harnery:v3:generation", "utf8"),
        32,
      ),
    );
  }
  const digest = createHmac("sha256", comparisonKey)
    .update(`harnery:v3:${domain}\0`, "utf8")
    .update(canonicalJsonV3(value), "utf8")
    .digest("hex");
  return {
    algorithm: "hmac-sha256",
    canonicalizer: EVENT_V3_CANONICALIZER,
    key_epoch: context.epochId,
    scope,
    digest: `sha256:${digest}`,
  };
}

export function normalizeNativeIdV3(
  context: FingerprintContextV3,
  namespace: string,
  nativeId: string,
): `hid_${string}` {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(namespace)) {
    throw new Error("native ID namespace is invalid");
  }
  const rootKey = Buffer.from(
    hkdfSync(
      "sha256",
      context.epochKey,
      Buffer.from(context.epochId, "utf8"),
      Buffer.from(`harnery:v3:root\0${context.rootId}`, "utf8"),
      32,
    ),
  );
  const digest = createHmac("sha256", rootKey)
    .update(`harnery:v3:native-id\0${namespace}\0`, "utf8")
    .update(nativeId.normalize("NFC"), "utf8")
    .digest("hex");
  return `hid_${digest}`;
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON rejects non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new Error(`canonical JSON rejects ${typeof value}`);
  }
  if (ancestors.has(value)) throw new Error("canonical JSON rejects cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical JSON accepts only plain objects");
    }
    const normalized = new Map<string, unknown>();
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalizedKey = key.normalize("NFC");
      if (normalized.has(normalizedKey)) {
        throw new Error("canonical JSON key collision after Unicode normalization");
      }
      normalized.set(normalizedKey, item);
    }
    const keys = [...normalized.keys()].sort(compareUtf16);
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${serialize(normalized.get(key), ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertDomain(domain: string): void {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(domain)) {
    throw new Error("fingerprint domain is invalid");
  }
}

