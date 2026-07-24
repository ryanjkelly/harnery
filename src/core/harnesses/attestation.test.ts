import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  attestationsDir,
  isAttestationCurrent,
  listAttestations,
  profileDigest,
  readAttestation,
  sealAttestation,
  validateAttestation,
  writeAttestation,
} from "./attestation.ts";
import { createBuiltinHarnessRegistry } from "./registry.ts";

const registry = createBuiltinHarnessRegistry();
const codex = registry.require("codex").profile;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-attest-"));
  mkdirSync(resolve(root, ".harnery"), { recursive: true });
  return root;
}

function record(overrides: Record<string, unknown> = {}) {
  return sealAttestation({
    schema_version: 1,
    harness: "codex",
    binary_version: "codex-cli 0.144.5",
    profile_digest: profileDigest(codex),
    observed_at: "2026-07-24T19:00:00.000Z",
    observations: { invocation: "supported", finalResult: "supported", sessionId: "unsupported" },
    ...overrides,
  });
}

describe("attestation store", () => {
  test("a written record round-trips", () => {
    const coordRoot = tempRoot();
    writeAttestation(record(), { coordRoot });
    const loaded = readAttestation("codex", { coordRoot });
    expect(loaded?.harness).toBe("codex");
    expect(loaded?.observations.sessionId).toBe("unsupported");
  });

  test("re-recording replaces rather than appends", () => {
    const coordRoot = tempRoot();
    writeAttestation(record(), { coordRoot });
    writeAttestation(record({ binary_version: "codex-cli 0.146.0" }), { coordRoot });
    expect(readAttestation("codex", { coordRoot })?.binary_version).toBe("codex-cli 0.146.0");
    expect(listAttestations({ coordRoot })).toHaveLength(1);
  });

  test("a missing record reads as null rather than throwing", () => {
    expect(readAttestation("codex", { coordRoot: tempRoot() })).toBeNull();
  });

  test("a hand-edited record is rejected", () => {
    const coordRoot = tempRoot();
    const path = writeAttestation(record(), { coordRoot });
    const tampered = JSON.parse(readFileSync(path, "utf8"));
    tampered.observations.sessionId = "supported";
    writeFileSync(path, JSON.stringify(tampered, null, 2));
    expect(readAttestation("codex", { coordRoot })).toBeNull();
  });

  test("an unknown schema version is rejected", () => {
    expect(validateAttestation({ ...record(), schema_version: 99 })).toBeNull();
  });

  test("malformed JSON reads as null", () => {
    const coordRoot = tempRoot();
    mkdirSync(attestationsDir({ coordRoot }), { recursive: true });
    writeFileSync(resolve(attestationsDir({ coordRoot }), "codex.json"), "{not json");
    expect(readAttestation("codex", { coordRoot })).toBeNull();
  });

  test("a harness id that would escape the store is refused", () => {
    expect(() =>
      writeAttestation(record({ harness: "../escape" }), { coordRoot: tempRoot() }),
    ).toThrow(/unsafe harness id/);
  });

  test("the record carries no prompt text and no host path", () => {
    const coordRoot = tempRoot();
    const body = readFileSync(writeAttestation(record(), { coordRoot }), "utf8");
    expect(body).not.toContain("Reply with");
    expect(body).not.toContain(coordRoot);
    expect(body).not.toMatch(/\/(home|Users)\//);
  });
});

describe("attestation staleness", () => {
  test("a matching version and declaration is current", () => {
    expect(isAttestationCurrent(record(), "codex-cli 0.144.5", codex)).toBe(true);
  });

  test("a vendor upgrade invalidates the record", () => {
    expect(isAttestationCurrent(record(), "codex-cli 0.146.0", codex)).toBe(false);
  });

  test("an edited declaration invalidates the record", () => {
    const edited = {
      ...codex,
      capabilities: { ...codex.capabilities, cost: { support: "supported" as const } },
    };
    expect(isAttestationCurrent(record(), "codex-cli 0.144.5", edited)).toBe(false);
  });

  test("an absent binary invalidates the record", () => {
    expect(isAttestationCurrent(record(), null, codex)).toBe(false);
  });

  test("a null record is never current", () => {
    expect(isAttestationCurrent(null, "codex-cli 0.144.5", codex)).toBe(false);
  });
});
