import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { sha256V3 } from "./canonical.ts";
import { liveGenesisIdV3, readEventV3ControlState } from "./control.ts";
import { liveInstanceIdV3, resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import { recordHookSignalV3 } from "./producers/recorder.ts";
import { readLedgerV3 } from "./reader.ts";
import { recoverInvalidEventLedgerV3 } from "./recovery.ts";
import { eventV3Paths, type WriteEventV3Options, withEventV3LedgerLease } from "./writer.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function recoveredRoot() {
  const root = mkdtempSync(join(tmpdir(), "harnery-recovery-wal-"));
  roots.push(root);
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("fixture"),
    approvalRecordId: "fixture-initial",
  });
  const before = liveGenesisIdV3(root);
  hook(root, "existing", "session-start");
  appendFileSync(eventV3Paths(root).active, '{"invalid_fixture":true}\n');
  expect(readEventV3ControlState(root)).toEqual({
    state: "invalid",
    reason: "ledger_integrity_failure",
  });
  const recovery = recoverInvalidEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture-after",
    hostBuild: "fixture-host",
    configDigest: sha256V3("fixture"),
    approvalRecordId: "fixture-recovery",
  });
  expect(recovery.state).toBe("recovered");
  expect(liveGenesisIdV3(root)).not.toBe(before);
  expect(readLedgerV3(root).events.map(({ event }) => event.event_type)).toEqual([
    "ledger.genesis",
    "ledger.activated",
  ]);
  return root;
}

function hook(
  root: string,
  session: string,
  signal: "session-start" | "user-prompt-submit" | "pre-tool-use" | "post-tool-use",
  writerOptions?: WriteEventV3Options,
) {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error(`Expected a live V3 route: ${route.state}`);
  return recordHookSignalV3({
    coordRoot: root,
    mode: route.mode,
    signal,
    payload: {
      session_id: session,
      turn_id: `${session}-turn`,
      tool_use_id: `${session}-tool`,
      tool_name: "Read",
      tool_input: { file_path: "fixture.txt" },
      tool_response: "fixture",
      raw: {},
    },
    adapter: "claude-code",
    instance_id: liveInstanceIdV3(`fixture-${session}`),
    producer_id: "prd_agent-hook",
    build_id: route.build_id,
    platform: "linux",
    writerOptions,
  });
}

function ready(root: string) {
  return readdirSync(eventV3Paths(root).spool).filter((name) => name.endsWith(".ready"));
}

function expectCommitted(root: string) {
  expect(ready(root)).toEqual([]);
  const current = readLedgerV3(root, { authority: "active" });
  expect(current.complete).toBe(true);
  expect(current.diagnostics).toEqual([]);
  const ids = current.events.map(({ event }) => event.event_id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(current.failed_epochs).toHaveLength(1);
  return current;
}

test("recovered hook producers commit re-onboarding inline without a manual drain", () => {
  const root = recoveredRoot();
  const phases: string[] = [];
  const writerOptions: WriteEventV3Options = {
    onStep: (step, eventId) => phases.push(`${step}:${eventId}`),
  };
  for (const session of ["existing", "second", "third", "fourth"]) {
    for (const signal of ["user-prompt-submit", "pre-tool-use", "post-tool-use"] as const) {
      const result = hook(root, session, signal, writerOptions);
      expect(result.state).toBe("recorded");
      if (result.state !== "recorded") throw new Error(`Unexpected hook state: ${result.state}`);
      expect(result.durability).toMatchObject({ state: "committed" });
      expect(result.durability.diagnostic_code).toBeUndefined();
    }
  }
  const current = expectCommitted(root);
  expect(current.events.filter(({ event }) => event.event_type === "session.started")).toHaveLength(
    4,
  );
  const published = phases
    .filter((phase) => phase.startsWith("ready_published:"))
    .map((phase) => phase.slice("ready_published:".length));
  const appended = phases
    .filter((phase) => phase.startsWith("active_row_appended:"))
    .map((phase) => phase.slice("active_row_appended:".length));
  expect(published.length).toBeGreaterThanOrEqual(16);
  expect(appended).toEqual(published);
}, 20_000);

test("a later hook drains the complete recovered batch after append-lease refusal", () => {
  const root = recoveredRoot();
  withEventV3LedgerLease(root, {}, () => {
    for (const session of ["existing", "second", "third", "fourth"]) {
      for (const signal of ["user-prompt-submit", "pre-tool-use", "post-tool-use"] as const) {
        const result = hook(root, session, signal);
        expect(result.state).toBe("recorded");
        if (result.state !== "recorded") throw new Error(`Unexpected hook state: ${result.state}`);
        expect(result.durability).toMatchObject({
          state: "ready",
          diagnostic_code: "wal_drain_failed",
        });
      }
    }
  });
  const pending = ready(root).map(
    (name) =>
      JSON.parse(readFileSync(join(eventV3Paths(root).spool, name), "utf8")).event_id as string,
  );
  expect(pending.length).toBeGreaterThanOrEqual(16);
  expect(readLedgerV3(root).events).toHaveLength(2);
  const next = hook(root, "later-producer", "user-prompt-submit");
  expect(next.state).toBe("recorded");
  if (next.state !== "recorded") throw new Error(`Unexpected hook state: ${next.state}`);
  expect(next.durability.state).toBe("committed");
  const current = expectCommitted(root);
  const ids = new Set(current.events.map(({ event }) => event.event_id));
  for (const id of pending) expect(ids.has(id as `evt_${string}`)).toBe(true);
}, 20_000);

test("a later hook recovers a process interruption immediately after ready publication", () => {
  const root = recoveredRoot();
  expect(() =>
    hook(root, "interrupted", "user-prompt-submit", {
      onStep: (step) => {
        if (step === "ready_published")
          throw new Error("fixture process exited before inline drain");
      },
    }),
  ).toThrow("fixture process exited before inline drain");
  expect(ready(root)).toHaveLength(1);
  expect(hook(root, "later-producer", "user-prompt-submit").state).toBe("recorded");
  expectCommitted(root);
  expect(hook(root, "interrupted", "user-prompt-submit").state).toBe("recorded");
  expectCommitted(root);
});
