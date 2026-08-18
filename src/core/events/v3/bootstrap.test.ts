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
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { sha256V3 } from "./canonical.ts";
import { readEventV3ControlState } from "./control.ts";
import { readFingerprintKeyStoreV3 } from "./fingerprint-keys.ts";
import { eventV3Paths } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("universal V3 ledger initialization", () => {
  test("creates an active epoch and is idempotent", () => {
    const root = freshRoot();
    const first = initialize(root, "2026-08-18T12:00:00.000Z");
    expect(first.initialized).toBeTrue();
    expect(first.control.state).toBe("active");
    const before = readFileSync(eventV3Paths(root).active, "utf8");

    const second = initialize(root, "2026-08-18T12:01:00.000Z");
    expect(second.initialized).toBeFalse();
    expect(readFileSync(eventV3Paths(root).active, "utf8")).toBe(before);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("archives an existing epoch intact before a forced replacement", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const before = readFileSync(eventV3Paths(root).active, "utf8");

    const replaced = initializeEventLedgerV3({
      ...baseInput(root, "2026-08-18T12:02:00.000Z"),
      forceNewEpoch: true,
    });

    expect(replaced.initialized).toBeTrue();
    expect(replaced.archived_epoch).toBeDefined();
    expect(readFileSync(join(replaced.archived_epoch!, "active.ndjson"), "utf8")).toBe(before);
    expect(readFileSync(eventV3Paths(root).active, "utf8")).not.toBe(before);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("archives an incompatible ledger directory instead of rewriting it", () => {
    const root = freshRoot();
    const ledgerRoot = join(root, ".harnery", "ledgers", "v3");
    mkdirSync(ledgerRoot, { recursive: true });
    const incompatible = '{"schema_version":1,"event_type":"legacy"}\n';
    writeFileSync(join(ledgerRoot, "active.ndjson"), incompatible);

    const result = initialize(root, "2026-08-18T12:03:00.000Z");

    expect(result.archived_epoch).toBeDefined();
    expect(readFileSync(join(result.archived_epoch!, "active.ndjson"), "utf8")).toBe(incompatible);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("seals an existing V2 epoch in place for audit-only access", () => {
    const root = freshRoot();
    const v2Root = join(root, ".harnery", "ledgers", "v2");
    mkdirSync(v2Root, { recursive: true });
    const active = join(v2Root, "active.ndjson");
    writeFileSync(active, "sealed history\n");

    const result = initialize(root, "2026-08-18T12:04:00.000Z");

    expect(result.sealed_v2).toBe(join(v2Root, "SEALED.json"));
    const receipt = JSON.parse(readFileSync(result.sealed_v2!, "utf8"));
    expect(receipt).toMatchObject({
      format: "harnery-event-ledger-v2-seal",
      policy: "audit-read-only",
      superseded_by: { major: 3 },
    });
    expect(statSync(active).mode & 0o777).toBe(0o400);
    expect(statSync(v2Root).mode & 0o777).toBe(0o500);

    // Restore owner write permission only so the temporary fixture can be removed.
    chmodSync(v2Root, 0o700);
  });

  test("preserves the active V2 privacy epoch during activation", () => {
    const root = freshRoot();
    const privateDir = join(root, ".harnery", "private");
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(privateDir, "fingerprint-keys.json"),
      `${JSON.stringify({
        format: "harnery-v2-fingerprint-keys",
        format_version: 1,
        active_epoch_id: "pep_fixture",
        epochs: [
          {
            epoch_id: "pep_fixture",
            key_base64url: Buffer.alloc(32, 7).toString("base64url"),
            created_at: "2026-08-16T17:00:00.000Z",
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    const result = initialize(root, "2026-08-18T12:05:00.000Z");

    expect(result.control.genesis.profile.privacy_key_epoch).toBe("pep_fixture");
    expect(readFingerprintKeyStoreV3(root).active_epoch_id).toBe("pep_fixture");
    expect(
      JSON.parse(readFileSync(join(privateDir, "fingerprint-keys.json"), "utf8")).format,
    ).toBe("harnery-v2-fingerprint-keys");
  });
});

function initialize(root: string, timestamp: string) {
  return initializeEventLedgerV3(baseInput(root, timestamp));
}

function baseInput(root: string, timestamp: string) {
  return {
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-universal-v3",
    now: () => new Date(timestamp),
  } as const;
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-bootstrap-"));
  roots.push(root);
  return root;
}
