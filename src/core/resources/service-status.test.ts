import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";
import { RESOURCE_SERVICE_STATUS_SCHEMA_VERSION } from "./contract.ts";
import { readResourceServiceStatus } from "./service-status.ts";
import { resourcePaths, writePrivateJsonAtomic } from "./storage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resource observer service status", () => {
  test("distinguishes a live owner from a stale heartbeat and a stopped record", () => {
    const root = mkdtempSync(join(tmpdir(), "harn-resource-status-"));
    roots.push(root);
    const now = Date.now();
    const base = {
      schema_version: RESOURCE_SERVICE_STATUS_SCHEMA_VERSION,
      pid: process.pid,
      start_token: processStartToken(process.pid),
      host: hostname(),
      nonce: "test-owner",
      state: "running" as const,
      started_at: new Date(now - 1_000).toISOString(),
      heartbeat_at: new Date(now).toISOString(),
      interval_ms: 2_000,
      sample_count: 2,
    };
    writePrivateJsonAtomic(resourcePaths(root).service, base);

    expect(readResourceServiceStatus(root, now)).toMatchObject({ running: true, stale: false });
    expect(readResourceServiceStatus(root, now + 16_000)).toMatchObject({
      running: false,
      stale: true,
    });

    writePrivateJsonAtomic(resourcePaths(root).service, { ...base, state: "stopped" });
    expect(readResourceServiceStatus(root, now)).toMatchObject({ running: false, stale: false });
  });
});
