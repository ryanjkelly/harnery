import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { processStartToken } from "../agents/state/proc-start.ts";
import { requestResourceServiceStop, runResourceService, spawnResourceService } from "./service.ts";
import { readResourceServiceStatus } from "./service-status.ts";
import { resourcePaths, writePrivateJsonAtomic } from "./storage.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(startToken: string | undefined = "recorded", state = "running"): string {
  const root = mkdtempSync(join(tmpdir(), "harn-resource-generation-"));
  roots.push(root);
  writePrivateJsonAtomic(resourcePaths(root).service, {
    schema_version: 1,
    pid: process.pid,
    start_token: startToken,
    host: hostname(),
    nonce: "test",
    state,
    heartbeat_at: new Date().toISOString(),
  });
  return root;
}

describe("legacy observer process identity", () => {
  test("mismatched and missing tokens never authorize a signal", () => {
    for (const recorded of ["recorded", undefined]) {
      const root = fixture(recorded);
      if (!recorded)
        writePrivateJsonAtomic(resourcePaths(root).service, {
          schema_version: 1,
          pid: process.pid,
          host: hostname(),
          state: "running",
          heartbeat_at: new Date().toISOString(),
        });
      const signals: number[] = [];
      const status = requestResourceServiceStop(root, {
        readToken: () => "replacement",
        probePid: () => true,
        kill: (pid) => signals.push(pid),
      });
      expect(status.signal_sent).toBe(false);
      expect(status.signal_verdict).toBe(recorded ? "different" : "unknown");
      expect(existsSync(resourcePaths(root).stop)).toBe(true);
      expect(signals).toEqual([]);
    }
  });

  test("an unreadable token never authorizes a signal", () => {
    const root = fixture();
    const signals: number[] = [];
    const status = requestResourceServiceStop(root, {
      readToken: () => {
        throw new Error("unreadable");
      },
      probePid: () => true,
      kill: (pid) => signals.push(pid),
    });
    expect(status).toMatchObject({
      generation: "unknown",
      liveness: "unknown",
      signal_sent: false,
      signal_verdict: "unknown",
    });
    expect(signals).toEqual([]);
  });

  test("the token is rechecked after writing the stop request", () => {
    const root = fixture();
    let reads = 0;
    const signals: number[] = [];
    const status = requestResourceServiceStop(root, {
      readToken: () => {
        reads += 1;
        if (reads > 1) expect(existsSync(resourcePaths(root).stop)).toBe(true);
        return reads === 1 ? "recorded" : "replacement";
      },
      probePid: () => true,
      kill: (pid) => signals.push(pid),
    });
    expect(status.signal_sent).toBe(false);
    expect(status.signal_verdict).toBe("different");
    expect(signals).toEqual([]);
  });

  test("a verified same generation can receive the stop signal", () => {
    const root = fixture();
    const signals: number[] = [];
    const status = requestResourceServiceStop(root, {
      readToken: () => "recorded",
      probePid: () => true,
      kill: (pid) => {
        expect(existsSync(resourcePaths(root).stop)).toBe(true);
        signals.push(pid);
      },
    });
    expect(status.signal_sent).toBe(true);
    expect(status.signal_verdict).toBe("same");
    expect(signals).toEqual([process.pid]);
  });

  test("a terminal record without a token stays unknown and blocks startup", async () => {
    const root = fixture();
    const record = {
      schema_version: 1,
      pid: process.pid,
      host: hostname(),
      state: "stopped",
      heartbeat_at: new Date().toISOString(),
    };
    writePrivateJsonAtomic(resourcePaths(root).service, record);
    expect(readResourceServiceStatus(root)).toMatchObject({
      generation: "unknown",
      liveness: "unknown",
    });
    await expect(spawnResourceService(root)).rejects.toThrow("durable stop request");
    await expect(runResourceService({ coordRoot: root, maxSamples: 1 })).rejects.toThrow(
      "durable stop request",
    );
  });

  test("an unknown lease leaves both the lease and stop request untouched", async () => {
    const root = mkdtempSync(join(tmpdir(), "harn-resource-unknown-lease-"));
    roots.push(root);
    const paths = resourcePaths(root);
    writePrivateJsonAtomic(paths.lease, { pid: process.pid, host: hostname(), nonce: "unknown" });
    writePrivateJsonAtomic(paths.stop, { retained: true });
    const lease = readFileSync(paths.lease, "utf8");
    const stop = readFileSync(paths.stop, "utf8");
    await expect(spawnResourceService(root)).rejects.toThrow("durable stop request");
    await expect(runResourceService({ coordRoot: root, maxSamples: 1 })).rejects.toThrow(
      "durable stop request",
    );
    expect(readFileSync(paths.lease, "utf8")).toBe(lease);
    expect(readFileSync(paths.stop, "utf8")).toBe(stop);
  });

  test("malformed and old live leases cannot be overwritten", async () => {
    for (const owner of [
      { pid: -99999999, host: hostname(), nonce: "invalid" },
      {
        pid: process.pid,
        start_token: processStartToken(process.pid),
        host: hostname(),
        nonce: "old-live",
        created_at: new Date(0).toISOString(),
      },
    ]) {
      const root = mkdtempSync(join(tmpdir(), "harn-resource-retained-lease-"));
      roots.push(root);
      const paths = resourcePaths(root);
      writePrivateJsonAtomic(paths.lease, owner);
      const lease = readFileSync(paths.lease, "utf8");
      await expect(spawnResourceService(root)).rejects.toThrow();
      await expect(runResourceService({ coordRoot: root, maxSamples: 1 })).rejects.toThrow();
      expect(readFileSync(paths.lease, "utf8")).toBe(lease);
    }
  });

  test("permission and probe errors cannot prove the observer is stopped", () => {
    const root = fixture();
    for (const code of ["ESRCH", "EPERM", "EIO"]) {
      const status = readResourceServiceStatus(root, Date.now(), {
        readToken: () => "recorded",
        probePid: () => {
          throw Object.assign(new Error(code), { code });
        },
      });
      expect(status).toMatchObject({
        generation: "unknown",
        liveness: code === "ESRCH" ? "stopped" : "unknown",
      });
    }
  });
});
