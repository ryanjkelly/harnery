import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintV2 } from "./canonical.ts";
import {
  fingerprintContextV2,
  fingerprintKeyStorePathV2,
  loadOrCreateFingerprintKeyStoreV2,
  readFingerprintKeyStoreV2,
  rotateFingerprintEpochV2,
} from "./fingerprint-keys.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 fingerprint key store", () => {
  test("creates one owner-only epoch and reuses it without exposing key bytes in fingerprints", () => {
    const root = temporaryRoot("event-v2-keys");
    const now = () => new Date("2026-08-16T12:00:00.000Z");
    const first = loadOrCreateFingerprintKeyStoreV2(root, now);
    const second = loadOrCreateFingerprintKeyStoreV2(root, now);

    expect(second).toEqual(first);
    expect(statSync(fingerprintKeyStorePathV2(root)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, ".harnery/private")).mode & 0o777).toBe(0o700);

    const context = fingerprintContextV2(
      root,
      "root_example",
      "gen_018f22b8-7dd3-7cc7-98c7-84c7fd6fdb5d",
    );
    const fingerprint = fingerprintV2(context, "exact-input", { secret: "do-not-store" });
    expect(fingerprint.key_epoch).toBe(first.active_epoch_id);
    expect(JSON.stringify(fingerprint)).not.toContain("do-not-store");
    expect(JSON.stringify(fingerprint)).not.toContain(first.epochs[0]?.key_base64url ?? "missing");
  });

  test("retains prior comparison epochs and refuses rotation while a generation is active", () => {
    const root = temporaryRoot("event-v2-rotate-key");
    const first = loadOrCreateFingerprintKeyStoreV2(root);
    expect(() => rotateFingerprintEpochV2(root, { activeGenerationCount: 1 })).toThrow(
      "blocked while generations are active",
    );

    const rotated = rotateFingerprintEpochV2(root, { activeGenerationCount: 0 });
    expect(rotated.epochs).toHaveLength(2);
    expect(rotated.active_epoch_id).not.toBe(first.active_epoch_id);
    expect(
      fingerprintContextV2(root, "root_example", undefined, first.active_epoch_id).epochId,
    ).toBe(first.active_epoch_id);
  });

  test("fails closed on permissive modes and malformed or extended secret records", () => {
    const root = temporaryRoot("event-v2-bad-key");
    const store = loadOrCreateFingerprintKeyStoreV2(root);
    const path = fingerprintKeyStorePathV2(root);
    chmodSync(path, 0o644);
    expect(() => readFingerprintKeyStoreV2(root)).toThrow("owner-only");

    chmodSync(path, 0o600);
    writeFileSync(path, `${JSON.stringify({ ...store, leaked: "value" })}\n`, "utf8");
    expect(() => readFingerprintKeyStoreV2(root)).toThrow("unsupported fields");
    expect(readFileSync(path, "utf8")).not.toContain("do-not-store");
  });

  test("does not trust a pre-created permissive private directory", () => {
    const root = temporaryRoot("event-v2-private-mode");
    mkdirSync(join(root, ".harnery/private"), { recursive: true, mode: 0o777 });
    loadOrCreateFingerprintKeyStoreV2(root);
    expect(statSync(join(root, ".harnery/private")).mode & 0o777).toBe(0o700);
  });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}
