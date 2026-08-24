import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { sha256V3 } from "./canonical.ts";
import {
  EVENT_V3_ACTIVATION_MANIFEST,
  EVENT_V3_GENESIS_MANIFEST,
  readEventV3ControlState,
} from "./control.ts";
import { resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import { eventV3Paths } from "./writer.ts";
import { acquireNoClobberLease } from "../../workflow/workspaces/leases.ts";

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

  test("names a prior schema digest and rotates it through init without recovery", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const genesisPath = join(root, EVENT_V3_GENESIS_MANIFEST);
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8")) as {
      profile: { initial_schema_digest: string };
    };
    genesis.profile.initial_schema_digest = `sha256:${"a".repeat(64)}`;
    writeFileSync(genesisPath, `${JSON.stringify(genesis)}\n`, "utf8");

    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "genesis_schema_digest_incompatible",
    });

    const replaced = initialize(root, "2026-08-18T12:03:00.000Z");

    expect(replaced.archived_epoch).toBeDefined();
    expect(readEventV3ControlState(root).state).toBe("active");
    const archivedGenesis = JSON.parse(
      readFileSync(join(replaced.archived_epoch!, "genesis.json"), "utf8"),
    ) as { profile: { initial_schema_digest: string } };
    expect(archivedGenesis.profile.initial_schema_digest).toBe(`sha256:${"a".repeat(64)}`);
  });

  test("refreshes a schema-incompatible epoch at the live routing boundary", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const genesisPath = join(root, EVENT_V3_GENESIS_MANIFEST);
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8")) as {
      profile: { initial_schema_digest: string };
    };
    genesis.profile.initial_schema_digest = `sha256:${"b".repeat(64)}`;
    writeFileSync(genesisPath, `${JSON.stringify(genesis)}\n`, "utf8");

    const route = resolveLiveEventLedgerRouteV3(root);

    expect(route).toMatchObject({ state: "v3", mode: "active" });
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("serializes runtime refresh and succeeds after the bootstrap lease clears", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const genesisPath = join(root, EVENT_V3_GENESIS_MANIFEST);
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8")) as {
      profile: { initial_schema_digest: string };
    };
    genesis.profile.initial_schema_digest = `sha256:${"d".repeat(64)}`;
    writeFileSync(genesisPath, `${JSON.stringify(genesis)}\n`, "utf8");
    const lease = acquireNoClobberLease({
      path: join(root, ".harnery", "private", "event-v3-bootstrap-lease"),
      scope: "event-v3-bootstrap",
      authoritySha256: createHash("sha256").update(root).digest("hex"),
      staleAfterMs: 10_000,
      validateStaleOwner: (owner) => owner.host === hostname() && owner.pid !== process.pid,
    });

    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({
      state: "blocked",
      reason: expect.stringContaining("runtime_refresh_failed"),
    });
    lease.release();
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });
  });

  test("resumes a candidate left before activation publication", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const active = eventV3Paths(root).active;
    const genesisRow = readFileSync(active, "utf8").split("\n")[0];
    writeFileSync(active, `${genesisRow}\n`, "utf8");
    unlinkSync(join(root, EVENT_V3_ACTIVATION_MANIFEST));
    expect(readEventV3ControlState(root).state).toBe("candidate");

    const resumed = initializeEventLedgerV3({
      ...baseInput(root, "2026-08-18T12:01:00.000Z"),
      resumeCandidate: true,
    });

    expect(resumed.control.state).toBe("active");
    expect(readEventV3ControlState(root).state).toBe("active");
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
