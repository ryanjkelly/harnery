import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import { acquireNoClobberLease } from "../../storage/no-clobber-lease.ts";
import { priorBreakingDigestV3 } from "./__fixtures__/ledger-replay.ts";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { sha256V3 } from "./canonical.ts";
import {
  EVENT_V3_ACTIVATION_MANIFEST,
  EVENT_V3_GENESIS_MANIFEST,
  readEventV3ControlState,
} from "./control.ts";
import { resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import { eventV3Paths } from "./writer.ts";

const roots: string[] = [];
/** The newest digest before the lineage's last breaking change. */
const PRIOR_BREAKING_DIGEST = priorBreakingDigestV3();

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
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
      replacement: { kind: "approved", command: "initialize_force_new_epoch" },
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
    genesis.profile.initial_schema_digest = PRIOR_BREAKING_DIGEST;
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
    expect(archivedGenesis.profile.initial_schema_digest).toBe(PRIOR_BREAKING_DIGEST);
  });

  test("refreshes a schema-incompatible epoch at the live routing boundary", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const genesisPath = join(root, EVENT_V3_GENESIS_MANIFEST);
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8")) as {
      profile: { initial_schema_digest: string };
    };
    genesis.profile.initial_schema_digest = PRIOR_BREAKING_DIGEST;
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
    genesis.profile.initial_schema_digest = PRIOR_BREAKING_DIGEST;
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

  test("decides a replacement from the state read under the bootstrap lease", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const before = readFileSync(eventV3Paths(root).active, "utf8");
    const seen: string[] = [];

    const kept = initializeEventLedgerV3({
      ...baseInput(root, "2026-08-18T12:02:00.000Z"),
      replacement: {
        kind: "automatic",
        cause: "init_refresh",
        replaces: (current) => {
          seen.push(current.state);
          return false;
        },
      },
    });
    expect(seen).toEqual(["active"]);
    expect(kept.initialized).toBeFalse();
    expect(kept.archived_epoch).toBeUndefined();
    expect(readFileSync(eventV3Paths(root).active, "utf8")).toBe(before);

    const replaced = initializeEventLedgerV3({
      ...baseInput(root, "2026-08-18T12:03:00.000Z"),
      replacement: { kind: "automatic", cause: "init_refresh", replaces: () => true },
    });
    expect(replaced.initialized).toBeTrue();
    expect(replaced.archived_epoch).toBeDefined();
  });

  test("refuses to replace a present epoch it cannot serve unless forced", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    appendFileSync(eventV3Paths(root).active, "{not an event\n");
    const before = readFileSync(eventV3Paths(root).active, "utf8");
    expect(readEventV3ControlState(root)).toEqual({
      state: "invalid",
      reason: "ledger_integrity_failure",
    });

    expect(() => initialize(root, "2026-08-18T12:01:00.000Z")).toThrow(
      "event_v3_epoch_not_replaced:ledger_integrity_failure",
    );
    expect(readFileSync(eventV3Paths(root).active, "utf8")).toBe(before);
    expect(existsSync(join(root, ".harnery", "ledgers", "v3-archives"))).toBeFalse();

    const replaced = initializeEventLedgerV3({
      ...baseInput(root, "2026-08-18T12:02:00.000Z"),
      replacement: { kind: "approved", command: "initialize_force_new_epoch" },
    });
    expect(replaced.archived_epoch).toBeDefined();
    expect(readFileSync(join(replaced.archived_epoch!, "active.ndjson"), "utf8")).toBe(before);
    expect(readEventV3ControlState(root).state).toBe("active");
  });

  test("writes genesis manifest version 2 for a first-time initialization", () => {
    const root = freshRoot();
    initialize(root, "2026-08-18T12:00:00.000Z");
    const genesis = JSON.parse(readFileSync(join(root, EVENT_V3_GENESIS_MANIFEST), "utf8"));
    expect(genesis.manifest_version).toBe(2);
    const activation = JSON.parse(readFileSync(join(root, EVENT_V3_ACTIVATION_MANIFEST), "utf8"));
    expect(activation.manifest_version).toBe(1);
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
