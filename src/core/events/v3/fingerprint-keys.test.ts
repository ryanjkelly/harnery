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

function unsupportedStore(root: string, extra: Record<string, unknown> = {}): string {
  roots.push(root);
  const storePath = fingerprintKeyStorePathV3(root);
  mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  writeFileSync(
    storePath,
    `${JSON.stringify({
      format: "unsupported-fingerprint-keys",
      format_version: 1,
      active_epoch_id: "pep_unsupported-cutover",
      epochs: [
        {
          epoch_id: "pep_unsupported-cutover",
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

describe("event ledger V3 fingerprint-key envelope", () => {
  test("refuses a non-V3 envelope without rewriting it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "harn-v3-key-refusal-"));
    const storePath = unsupportedStore(root);
    const before = readFileSync(storePath, "utf8");

    expect(() => loadOrCreateFingerprintKeyStoreV3(root)).toThrow(
      "fingerprint key store format is unsupported",
    );
    expect(() => readFingerprintKeyStoreV3(root)).toThrow(
      "fingerprint key store format is unsupported",
    );
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });

  test("does not rewrite an envelope with unsupported fields", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "harn-v3-key-field-refusal-"));
    const storePath = unsupportedStore(root, { unexpected: true });
    const before = readFileSync(storePath, "utf8");

    expect(() => loadOrCreateFingerprintKeyStoreV3(root)).toThrow(
      "fingerprint key store has unsupported fields",
    );
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });
});
