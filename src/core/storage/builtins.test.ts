import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { harneryStorageFamilies } from "./builtins.ts";
import { createStorageCatalog } from "./catalog.ts";

describe("source-owned storage descriptors", () => {
  const root = resolve("/tmp/harnery-storage-builtins");
  const catalog = createStorageCatalog({ coord_root: root, project_root: root });

  test("registers every Slice 1 storage class and named family", () => {
    expect(new Set(catalog.families.map((family) => family.storage_class))).toEqual(
      new Set([
        "canonical-authority",
        "recovery-state",
        "operational-log",
        "debug-log",
        "durable-object-history",
        "repairable-cache",
        "managed-artifact",
      ]),
    );
    for (const id of [
      "coord-message-inbox",
      "agent-mailbox-history",
      "workflow-approval-history",
      "agent-name-history",
      "storage-maintenance-transactions",
      "storage-maintenance-mutation-receipts",
      "storage-maintenance-run-log",
      "storage-maintenance-cursors",
      "storage-exports",
      "managed-artifacts",
      "captured-images",
      "adapter-native-conversations",
      "conversation-archive",
      "dev-scratch",
    ]) {
      expect(catalog.get(id), id).toBeDefined();
    }
  });

  test("keeps V3 canonical authority separate from support storage", () => {
    const canonical = catalog.require("event-v3-canonical-active");
    const support = catalog.require("event-v3-support-active");
    expect(canonical.resolved_roots.some((root) => root.path.endsWith("/ledgers/v3"))).toBeFalse();
    expect(
      canonical.resolved_roots.every((root) => !root.path.includes("/diagnostics")),
    ).toBeTrue();
    expect(support.resolved_roots.some((root) => root.path.includes("/diagnostics"))).toBeTrue();
    expect(
      catalog
        .familiesForPath(join(root, ".harnery", "ledgers", "v3", "control-state-witness.json"))
        .map((family) => family.id),
    ).toEqual(["event-v3-support-active"]);
    expect(
      catalog
        .familiesForPath(join(root, ".harnery", "ledgers", "v3", "control-state-validation.json"))
        .map((family) => family.id),
    ).toEqual(["event-v3-support-active"]);
    expect(catalog.require("legacy-canonical-ledgers").id).not.toBe(canonical.id);
    for (const directory of ["diagnostic-summaries", "intake", "authority-recoveries"]) {
      const path = join(root, ".harnery", "ledgers", "v3", directory, "fixture.json");
      expect(
        catalog.familiesForPath(path).map((family) => family.id),
        directory,
      ).toEqual(["event-v3-support-active"]);
      expect(
        canonical.resolved_roots.some((candidate) => path.startsWith(candidate.path)),
        directory,
      ).toBeFalse();
    }
  });

  test("declares owner-protocol and managed-content link handling", () => {
    const support = catalog.require("event-v3-support-active");
    const appendLease = support.resolved_roots.find((candidate) =>
      candidate.path.endsWith("/ledgers/v3/append-lease"),
    );
    expect(appendLease).toMatchObject({ kind: "directory", match: "exact" });
    expect(
      support.resolved_roots
        .filter((candidate) => candidate.match === "subtree")
        .every((candidate) => candidate.link_handling?.hard_links === "allow"),
    ).toBeTrue();
    expect(catalog.require("event-v3-support-archives").resolved_roots[0]).toMatchObject({
      link_handling: { symbolic_links: "reject", hard_links: "allow" },
    });
    expect(
      catalog.familiesForPath(
        join(root, ".harnery", "ledgers", "v3-archives", "epoch", "append-lease", "current"),
      ),
    ).toContainEqual(expect.objectContaining({ id: "event-v3-support-archives" }));
    expect(catalog.require("managed-artifacts").resolved_roots[0]).toMatchObject({
      link_handling: { symbolic_links: "skip", hard_links: "allow" },
    });
  });

  test("maps every current logical log and legacy path to exactly one family", () => {
    const paths = [
      [".harnery/debug/agent-hook.ndjson", "agent-hook-debug-log"],
      [".harnery/debug/agent-hook.errors.ndjson", "agent-hook-debug-log"],
      [".harnery/debug/agent-coord.ndjson", "agent-coord-debug-log"],
      [".harnery/debug/agent-coord.verdicts.ndjson", "agent-coord-debug-log"],
      [".harnery/logs/web-performance.jsonl", "web-performance-log"],
      [".harnery/logs/web-performance.jsonl.1", "web-performance-log"],
      [".harnery/semantic/v2/service.log", "semantic-service-log"],
      [".harnery/logs/resource-observer/active.jsonl", "resource-observer-log"],
      [".harnery/resources/snapshot.json", "resource-observer-cache"],
      [".harnery/governor-service/service.log", "governor-service-log"],
      [".harnery/governor-service/events.jsonl", "governor-service-log"],
      [".harnery/presence/relay-daemon.log", "presence-relay-log"],
      [".cache/tunnel/gate.log", "tunnel-process-log"],
      [".cache/tunnel/cloudflared-demo.log", "tunnel-process-log"],
      [".harnery/events.ndjson/V1-SEALED.json", "legacy-canonical-ledgers"],
      [".harnery/events-20260101.ndjson.1", "legacy-canonical-ledgers"],
    ] as const;
    for (const [relativePath, familyId] of paths) {
      expect(
        catalog.familiesForPath(join(root, relativePath)).map((family) => family.id),
        relativePath,
      ).toEqual([familyId]);
    }
  });

  test("catalog construction leaves dormant current and future roots absent", () => {
    const temporary = mkdtempSync(join(tmpdir(), "harnery-storage-dormant-"));
    try {
      createStorageCatalog({ coord_root: temporary, project_root: temporary });
      expect(existsSync(join(temporary, ".harnery"))).toBeFalse();
      expect(existsSync(join(temporary, ".cache"))).toBeFalse();
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  test("activates source-owned log storage budgets while keeping dev scratch writes disabled", () => {
    for (const family of catalog.families.filter(
      (candidate) =>
        candidate.storage_class === "operational-log" || candidate.storage_class === "debug-log",
    )) {
      expect(family.policy.retention.status, family.id).toBe("active");
      expect(family.policy.retention.max_bytes.limit, family.id).toBeGreaterThanOrEqual(
        64 * 1_024 * 1_024,
      );
    }
    expect(catalog.require("dev-scratch").policy.writes).toBe("disabled");
    expect(catalog.require("dev-scratch").policy.privacy.content).toBe("metadata-only");
    expect(catalog.require("dev-scratch").policy.retention.max_bytes.limit).toBe(
      64 * 1_024 * 1_024,
    );
  });

  test("keeps write activation separate from active retention budgets", () => {
    for (const familyId of [
      "semantic-service-log",
      "resource-observer-log",
      "governor-service-log",
      "presence-relay-log",
    ]) {
      const family = catalog.require(familyId);
      expect(family.policy.writes, familyId).toBe("active");
      expect(family.policy.retention.status, familyId).toBe("active");
      expect(family.provider.maintenance, familyId).toBe("storage");
    }
  });

  test("registers the inbox and metrics sidecar with their private owner contracts", () => {
    const inbox = catalog.require("coord-message-inbox");
    expect(inbox.durability).toBe("crash-safe");
    expect(inbox.writer_model).toBe("multi-process");
    expect(inbox.sensitivity).toBe("private");
    expect(inbox.policy.failure_behavior).toBe("reject-before-write");
    const metrics = catalog.require("structured-log-metrics");
    expect(metrics.storage_class).toBe("repairable-cache");
    expect(metrics.policy.reconstruction_source).toContain("structured log segments");
  });

  test("inventories local managed objects while delegating their maintenance", () => {
    for (const id of ["managed-artifacts", "captured-images", "storage-exports"]) {
      expect(catalog.require(id).provider).toMatchObject({
        kind: "filesystem",
        inventory: "filesystem",
        maintenance: "delegated",
      });
    }
    expect(catalog.require("adapter-native-conversations").provider).toMatchObject({
      inventory: "delegated",
      maintenance: "delegated",
    });
  });

  test("returns a fresh descriptor array without runtime registry mutation", () => {
    expect(harneryStorageFamilies()).not.toBe(harneryStorageFamilies());
  });
});
