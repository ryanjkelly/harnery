import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fingerprintKeyStorePathV3,
  loadOrCreateFingerprintKeyStoreV3,
  readFingerprintKeyStoreV3,
} from "./fingerprint-keys.ts";

const roots: string[] = [];

function legacyStore(root: string, extra: Record<string, unknown> = {}): string {
  roots.push(root);
  const storePath = fingerprintKeyStorePathV3(root);
  mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  writeFileSync(
    storePath,
    `${JSON.stringify({
      format: "harnery-v2-fingerprint-keys",
      format_version: 1,
      active_epoch_id: "pep_recorded-v2-cutover",
      epochs: [
        {
          epoch_id: "pep_recorded-v2-cutover",
          key_base64url: Buffer.alloc(32, 7).toString("base64url"),
          created_at: "2026-08-20T20:00:00.000Z",
        },
      ],
      ...extra,
    })}\n`,
  );
  chmodSync(storePath, 0o600);
  return storePath;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 fingerprint-key cutover", () => {
  test("migrates the recorded V2 envelope without changing its epoch or key", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "harn-v3-key-cutover-"));
    const storePath = legacyStore(root);
    const before = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;

    const migrated = loadOrCreateFingerprintKeyStoreV3(root);
    const after = JSON.parse(readFileSync(storePath, "utf8")) as Record<string, unknown>;

    expect(JSON.stringify(migrated)).toBe(
      JSON.stringify({ ...before, format: "harnery-v3-fingerprint-keys" }),
    );
    expect(JSON.stringify(after)).toBe(JSON.stringify(migrated));
    expect(readFingerprintKeyStoreV3(root)).toEqual(migrated);
    expect(loadOrCreateFingerprintKeyStoreV3(root)).toEqual(migrated);
  });

  test("does not rewrite a V2-shaped envelope with unsupported fields", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "harn-v3-key-refusal-"));
    const storePath = legacyStore(root, { unexpected: true });
    const before = readFileSync(storePath, "utf8");

    expect(() => loadOrCreateFingerprintKeyStoreV3(root)).toThrow(
      "fingerprint key store has unsupported fields",
    );
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });
});
