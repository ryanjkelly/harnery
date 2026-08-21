import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import { writeSessionEvent } from "./session-events.ts";

const roots: string[] = [];
const priorCoordRoot = process.env.HARNERY_COORD_ROOT_OVERRIDE;

afterEach(() => {
  if (priorCoordRoot === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
  else process.env.HARNERY_COORD_ROOT_OVERRIDE = priorCoordRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session event live ledger routing", () => {
  test("refuses command recording before the V3 ledger is initialized", () => {
    const root = temporaryRoot();
    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;

    writeSessionEvent("command.started", {
      instance_id: "agent-uninitialized",
      cmd_id: "cmd-uninitialized",
      cmd: "acme agents status",
      intent: "inspect status",
    });

    expect(existsSync(join(root, ".harnery", "ledgers", "v3", "active.ndjson"))).toBeFalse();
  });

  test("records command spans in the active V3 ledger", () => {
    const root = activeRoot();
    const instanceId = "agent-v3-fixture";
    const nativeSession = "native-v3-session";
    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-start",
        payload: { session_id: nativeSession, raw: {} },
        adapter: "claude-code",
        instanceId,
      }).state,
    ).toBe("recorded");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "user-prompt-submit",
        payload: { session_id: nativeSession, turn_id: "turn-1", prompt: "run it", raw: {} },
        adapter: "claude-code",
        instanceId,
      }).state,
    ).toBe("recorded");

    const secret = "do-not-retain-this-output";
    writeSessionEvent("command.started", {
      instance_id: instanceId,
      cmd_id: "cmd-v3",
      cmd: "acme agents status --json",
      intent: "inspect agents",
    });
    writeSessionEvent("command.output_observed", {
      instance_id: instanceId,
      cmd_id: "cmd-v3",
      stream: "stdout",
      line: secret,
    });
    writeSessionEvent("command.completed", {
      instance_id: instanceId,
      cmd_id: "cmd-v3",
      exit: 0,
      duration_ms: 25,
    });

    const commandEvents = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.producer.component === "session-tee");
    expect(commandEvents.map((event) => event.event_type)).toEqual([
      "command.started",
      "command.output_observed",
      "command.completed",
    ]);
    expect(existsSync(join(root, ".harnery/active", `${instanceId}.json`))).toBeFalse();
    expect(readFileSync(join(root, ".harnery/ledgers/v3/active.ndjson"), "utf8")).not.toContain(
      secret,
    );
  });

  test("classifies a command outside an open turn as unjoinable", () => {
    const root = activeRoot();
    const instanceId = "agent-v3-no-turn";
    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-start",
        payload: { session_id: "native-v3-no-turn", raw: {} },
        adapter: "claude-code",
        instanceId,
      }).state,
    ).toBe("recorded");

    writeSessionEvent("command.started", {
      instance_id: instanceId,
      cmd_id: "cmd-no-turn",
      cmd: "acme agents status",
      intent: "inspect status",
    });

    const diagnostics = readdirSync(join(root, ".harnery/ledgers/v3/diagnostics"));
    expect(diagnostics.some((name) => name.startsWith("command_emit_unjoinable-"))).toBeTrue();
    expect(diagnostics.some((name) => name.startsWith("command_emit_rejected-"))).toBeFalse();
  });
});

function activeRoot(): string {
  const root = temporaryRoot();
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("config"),
    approvalRecordId: "test-session-events",
    now: () => new Date("2026-08-16T18:00:00.000Z"),
  });
  return root;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-session-events-routing-"));
  roots.push(root);
  return root;
}
