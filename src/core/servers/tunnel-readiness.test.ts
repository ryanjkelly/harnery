import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TunnelState, tunnelReadiness } from "../../lib/tunnel/state.ts";
import {
  createTunnelReadinessVerifier,
  processStartToken,
  registerServer,
  type ServerRecord,
  serversDir,
  signalIfSameGeneration,
  tunnelServerInput,
  unregisterServer,
  withServerRegistrationCustody,
} from "./index.ts";

let root: string;
let state: TunnelState;
let receipt: ServerRecord;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tunnel-readiness-"));
  const originalToken = processStartToken(process.pid)!;
  expect(originalToken).toBeTruthy();
  state = {
    name: "readiness",
    provider: "cloudflare",
    url: "https://saved.example",
    gate_pid: process.pid,
    gate_start_token: originalToken,
    cloudflared_pid: process.pid,
    cloudflared_start_token: originalToken,
    started_at: "2026-10-19T00:00:00Z",
    target: "127.0.0.1:4276",
    vhost: "localhost:4276",
    gate_port: 9001,
    allow_paths: ["/"],
  };
  receipt = registerServer(tunnelServerInput(state, root), { coordRoot: root })!;
  state.registration_id = receipt.registration_id;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("original tunnel readiness authority", () => {
  test("matching original receipt and both generations produce ready", () => {
    expect(tunnelReadiness(state, createTunnelReadinessVerifier({ coordRoot: root }))).toBe(
      "ready",
    );
  });

  for (const [field, replacement] of [
    ["registration_id", "11111111-1111-4111-8111-111111111111"],
    ["pid", 2147483647],
    ["start_token", "another-original-token"],
    ["host", "another-host"],
    ["kind", "session"],
    ["type", "another-service"],
    ["port", 9002],
    ["url", "https://replacement.example"],
  ] as const) {
    test(`changed receipt ${field} remains unknown and retains evidence`, () => {
      const path = join(serversDir(root), `${receipt.id}.json`);
      const bytes = JSON.stringify({ ...receipt, [field]: replacement });
      writeFileSync(path, bytes);
      expect(tunnelReadiness(state, createTunnelReadinessVerifier({ coordRoot: root }))).toBe(
        "unknown",
      );
      expect(readFileSync(path, "utf8")).toBe(bytes);
    });
  }

  test("observations cannot run outside original registration custody", () => {
    const options = { coordRoot: root };
    const verifier = createTunnelReadinessVerifier(options);
    const observed: number[] = [];
    const original = verifier.observeProcess;
    verifier.observeProcess = (pid, token) => {
      observed.push(pid);
      return original(pid, token);
    };
    withServerRegistrationCustody(receipt, options, () => {
      expect(tunnelReadiness(state, verifier)).toBe("unknown");
      expect(observed).toEqual([]);
    });
  });

  test("an inconclusive process probe cannot report ready or dead", () => {
    const probe = spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    try {
      expect(tunnelReadiness(state, createTunnelReadinessVerifier({ coordRoot: root }))).toBe(
        "unknown",
      );
    } finally {
      probe.mockRestore();
    }
  });

  test("an older registry schema remains unknown without rewriting its record", () => {
    const path = join(serversDir(root), `${receipt.id}.json`);
    const bytes = JSON.stringify({ ...receipt, schema_version: 1 });
    writeFileSync(path, bytes);
    expect(tunnelReadiness(state, createTunnelReadinessVerifier({ coordRoot: root }))).toBe(
      "unknown",
    );
    expect(readFileSync(path, "utf8")).toBe(bytes);
  });

  test("dead requires actual absence of every original process", async () => {
    expect(unregisterServer(receipt, { coordRoot: root })).toBe(true);
    const child = Bun.spawn({
      cmd: [process.execPath, "--eval", "console.log('ready'); setInterval(() => {}, 1000)"],
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.stdout.getReader().read();
    const originalToken = processStartToken(child.pid)!;
    try {
      expect(originalToken).toBeTruthy();
      state = {
        ...state,
        gate_pid: child.pid,
        gate_start_token: originalToken,
        cloudflared_pid: child.pid,
        cloudflared_start_token: originalToken,
      };
      receipt = registerServer(tunnelServerInput(state, root), { coordRoot: root })!;
      state.registration_id = receipt.registration_id;
      expect(signalIfSameGeneration(child.pid, originalToken, "SIGKILL").sent).toBe(true);
      await child.exited;
      expect(tunnelReadiness(state, createTunnelReadinessVerifier({ coordRoot: root }))).toBe(
        "dead",
      );
    } finally {
      signalIfSameGeneration(child.pid, originalToken, "SIGKILL");
      await child.exited;
    }
  });
});
