import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3, rotateOversizedEventLedgerV3 } from "./bootstrap.ts";
import { sha256V3 } from "./canonical.ts";
import { liveGenesisIdV3, readEventV3ControlState } from "./control.ts";
import {
  liveHookSignalDefersDrainV3,
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "./live-routing.ts";
import { readHookProducerStateV3 } from "./producers/recorder.ts";
import { readLedgerV3 } from "./reader.ts";
import { recoverInvalidEventLedgerV3 } from "./recovery.ts";
import { eventV3Paths, withEventV3LedgerLease } from "./writer.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("bootstrap commits a recovered native-hook batch before archiving its epoch", () => {
  const root = mkdtempSync(join(tmpdir(), "harnery-recovery-bootstrap-"));
  roots.push(root);
  const initial = {
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("fixture"),
    approvalRecordId: "fixture-initial",
  };
  initializeEventLedgerV3(initial);
  const originalGenesis = liveGenesisIdV3(root);
  expect(nativeHook(root, "session-start").state).toBe("recorded");
  // Corrupt only this disposable fixture, then exercise supported recovery.
  appendFileSync(eventV3Paths(root).active, '{"invalid_fixture":true}\n');
  expect(readEventV3ControlState(root)).toEqual({
    state: "invalid",
    reason: "ledger_integrity_failure",
  });
  expect(
    recoverInvalidEventLedgerV3({
      ...initial,
      harneryBuild: "fixture-recovered",
      approvalRecordId: "fixture-recovery",
    }).state,
  ).toBe("recovered");
  const recoveredGenesis = liveGenesisIdV3(root);
  expect(recoveredGenesis).not.toBe(originalGenesis);

  withEventV3LedgerLease(root, {}, () => {
    const prompt = nativeHook(root, "user-prompt-submit");
    expect(prompt.state).toBe("recorded");
    if (prompt.state !== "recorded") throw new Error(`unexpected native prompt: ${prompt.state}`);
    expect(prompt.durability).toMatchObject({
      state: "ready",
      diagnostic_code: "wal_drain_failed",
    });
    const tool = nativeHook(root, "pre-tool-use");
    expect(tool.state).toBe("recorded");
    if (tool.state !== "recorded") throw new Error(`unexpected native tool: ${tool.state}`);
    expect(tool.durability.state).toBe("ready");
    // Tool hooks deliberately defer; this is distinct from failed inline drain.
    expect(tool.durability.diagnostic_code).toBeUndefined();
  });
  const pending = readyRecords(root);
  expect(pending.map((event) => event.event_type)).toEqual(
    expect.arrayContaining(["session.started", "turn.started", "tool.requested"]),
  );
  expect(readLedgerV3(root).events.map(({ event }) => event.event_type)).toEqual([
    "ledger.genesis",
    "ledger.activated",
  ]);
  const priorGeneration = readHookProducerStateV3(
    root,
    "claude-code",
    "native-bootstrap-session",
  )?.generation_id;
  expect(priorGeneration).toBeDefined();

  // Rotation is the normal bootstrap caller. This test never calls the drain
  // helper: bootstrap must commit the ready causal batch before moving it.
  const rotated = rotateOversizedEventLedgerV3(root, { thresholdBytes: 1 });
  expect(rotated.state).toBe("rotated");
  if (!rotated.archived_epoch) throw new Error("bootstrap did not archive the recovered epoch");
  const archived = readFileSync(join(rotated.archived_epoch, "active.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { event_id: string });
  for (const pendingEvent of pending) {
    expect(archived.filter((event) => event.event_id === pendingEvent.event_id)).toHaveLength(1);
  }
  expect(
    readdirSync(join(rotated.archived_epoch, "spool")).filter((name) => name.endsWith(".ready")),
  ).toEqual([]);
  expect(liveGenesisIdV3(root)).not.toBe(recoveredGenesis);
  const reanchored = readHookProducerStateV3(root, "claude-code", "native-bootstrap-session");
  expect(reanchored?.generation_id).toBeDefined();
  expect(reanchored?.generation_id).not.toBe(priorGeneration);
  expect(reanchored?.epoch_genesis_id).toBe(liveGenesisIdV3(root));
  expect(reanchored?.current_turn_id).toBeDefined();
  expect(reanchored?.current_turn_span).toBeDefined();

  const resumed = nativeHook(root, "user-prompt-submit", "native-bootstrap-next-turn");
  expect(resumed.state).toBe("recorded");
  if (resumed.state !== "recorded")
    throw new Error(`unexpected successor prompt: ${resumed.state}`);
  expect(resumed.durability.state).toBe("committed");
  expect(readyRecords(root)).toEqual([]);
  const ledger = readLedgerV3(root, { authority: "active" });
  expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
  const ids = ledger.events.map(({ event }) => event.event_id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ledger.events.some(({ event }) => event.event_type === "turn.started")).toBeTrue();
}, 20_000);

function nativeHook(
  root: string,
  eventName: "session-start" | "user-prompt-submit" | "pre-tool-use",
  turnId = "native-bootstrap-turn",
) {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error(`native hook route unavailable: ${route.state}`);
  return recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName,
    payload: {
      session_id: "native-bootstrap-session",
      turn_id: turnId,
      tool_use_id: "native-bootstrap-tool",
      tool_name: "Read",
      tool_input: { file_path: "fixture.txt" },
      prompt: "continue",
      raw: {},
    },
    adapter: "claude-code",
    instanceId: "native-bootstrap-instance",
    defer_drain: liveHookSignalDefersDrainV3(eventName),
  });
}

function readyRecords(root: string): Array<{ event_id: string; event_type: string }> {
  const spool = eventV3Paths(root).spool;
  return readdirSync(spool)
    .filter((name) => name.endsWith(".ready"))
    .map(
      (name) =>
        JSON.parse(readFileSync(join(spool, name), "utf8")) as {
          event_id: string;
          event_type: string;
        },
    );
}
