import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV2 } from "./bootstrap.ts";
import { sha256V2 } from "./canonical.ts";
import { readEventV2ControlState } from "./control.ts";
import { eventV2Paths } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("universal V2 ledger initialization", () => {
  test("creates an active epoch and is idempotent", () => {
    const root = freshRoot();
    const first = initialize(root, "2026-08-18T12:00:00.000Z");
    expect(first.initialized).toBeTrue();
    expect(first.control.state).toBe("active");
    const before = readFileSync(eventV2Paths(root).active, "utf8");

    const second = initialize(root, "2026-08-18T12:01:00.000Z");
    expect(second.initialized).toBeFalse();
    expect(readFileSync(eventV2Paths(root).active, "utf8")).toBe(before);
    expect(readEventV2ControlState(root).state).toBe("active");
  });

  test("archives an existing epoch intact before a forced replacement", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const before = readFileSync(eventV2Paths(root).active, "utf8");

    const replaced = initializeEventLedgerV2({
      ...baseInput(root, "2026-08-18T12:02:00.000Z"),
      forceNewEpoch: true,
    });

    expect(replaced.initialized).toBeTrue();
    expect(replaced.archived_epoch).toBeDefined();
    expect(readFileSync(join(replaced.archived_epoch!, "active.ndjson"), "utf8")).toBe(before);
    expect(readFileSync(eventV2Paths(root).active, "utf8")).not.toBe(before);
    expect(readEventV2ControlState(root).state).toBe("active");
  });

  test("archives an incompatible ledger directory instead of rewriting it", () => {
    const root = freshRoot();
    const ledgerRoot = join(root, ".harnery", "ledgers", "v2");
    mkdirSync(ledgerRoot, { recursive: true });
    const incompatible = '{"schema_version":1,"event_type":"legacy"}\n';
    writeFileSync(join(ledgerRoot, "active.ndjson"), incompatible);

    const result = initialize(root, "2026-08-18T12:03:00.000Z");

    expect(result.archived_epoch).toBeDefined();
    expect(readFileSync(join(result.archived_epoch!, "active.ndjson"), "utf8")).toBe(incompatible);
    expect(readEventV2ControlState(root).state).toBe("active");
  });
});

function initialize(root: string, timestamp: string) {
  return initializeEventLedgerV2(baseInput(root, timestamp));
}

function baseInput(root: string, timestamp: string) {
  return {
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V2("config"),
    approvalRecordId: "test-universal-v2",
    now: () => new Date(timestamp),
  } as const;
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v2-bootstrap-"));
  roots.push(root);
  return root;
}
