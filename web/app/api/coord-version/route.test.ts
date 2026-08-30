import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { __resetCoordRootCache } from "@/lib/coord-reader";
import { initializeEventLedgerV3 } from "../../../../src/core/events/v3/bootstrap";
import { startWorkflowChildSessionV3 } from "../../../../src/core/workflow/live-session-v3";
import { GET } from "./route";

let root: string;
let priorRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "harn-coord-version-"));
  for (const dir of ["active", "councils", "journal"]) {
    mkdirSync(path.join(root, ".harnery", dir), { recursive: true });
  }
  priorRoot = process.env.HARNERY_COORD_ROOT;
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
});

afterEach(() => {
  if (priorRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = priorRoot;
  __resetCoordRootCache();
  rmSync(root, { recursive: true, force: true });
});

describe("coord-version live refresh", () => {
  test("a canonical V3 event changes the polling signal", async () => {
    initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: "coord-version-test",
      hostBuild: "host-test",
      configDigest: `sha256:${"0".repeat(64)}`,
      approvalRecordId: "coord-version-test",
    });
    const before = (await GET().json()) as { v: string };

    startWorkflowChildSessionV3({
      coordRoot: root,
      instanceId: "agent",
      runId: "coord-version-test",
      agentId: "agent",
      adapter: "codex",
    });
    const after = (await GET().json()) as { v: string };
    expect(after.v).not.toBe(before.v);
  });

  test("a resource snapshot changes the polling signal", async () => {
    const before = (await GET().json()) as { v: string };
    const resourceDir = path.join(root, ".harnery", "resources");
    mkdirSync(resourceDir, { recursive: true });
    writeFileSync(path.join(resourceDir, "snapshot.json"), '{"schema_version":1}\n');
    const after = (await GET().json()) as { v: string };
    expect(after.v).not.toBe(before.v);
  });
});
