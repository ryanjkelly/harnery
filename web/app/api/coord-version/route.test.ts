import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { __resetCoordRootCache } from "@/lib/coord-reader";
import { GET } from "./route";

let root: string;
let priorRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "harn-coord-version-"));
  for (const dir of ["active", "councils", "journal"]) {
    mkdirSync(path.join(root, ".harnery", dir), { recursive: true });
  }
  writeFileSync(path.join(root, ".harnery", "events.ndjson"), "", "utf8");
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
  test("a lifecycle-only heartbeat write changes the polling signal", async () => {
    const heartbeatPath = path.join(root, ".harnery", "active", "agent.json");
    const heartbeat = {
      instance_id: "agent",
      session_id: "agent",
      name: "Maya",
      started_at: "2026-08-13T15:00:00Z",
      last_heartbeat: "2026-08-13T15:00:00Z",
      files_touched: [],
      task_state: "active",
    };
    writeFileSync(heartbeatPath, JSON.stringify(heartbeat), "utf8");
    const before = (await GET().json()) as { v: string };

    writeFileSync(
      heartbeatPath,
      JSON.stringify({
        ...heartbeat,
        task_state: "blocked",
        task_state_reason: "waiting for approval",
      }),
      "utf8",
    );
    const after = (await GET().json()) as { v: string };
    expect(after.v).not.toBe(before.v);
  });
});
