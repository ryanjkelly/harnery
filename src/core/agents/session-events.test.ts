import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJsonV2, sha256V2 } from "../events/v2/canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../events/v2/capabilities.ts";
import {
  buildCandidateGenesisManifestV2,
  type CandidateProfileV2,
  EVENT_V2_GENESIS_MANIFEST,
} from "../events/v2/control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../events/v2/fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../events/v2/generated.ts";
import {
  liveEventV2BuildId,
  recordLiveHookSignalV2,
  resolveLiveEventLedgerRouteV2,
} from "../events/v2/live-routing.ts";
import { readActiveLedgerV2 } from "../events/v2/reader.ts";
import { writeSessionEvent } from "./session-events.ts";

const roots: string[] = [];
const priorEventsPath = process.env.HARNERY_EVENTS_PATH;

afterEach(() => {
  if (priorEventsPath === undefined) delete process.env.HARNERY_EVENTS_PATH;
  else process.env.HARNERY_EVENTS_PATH = priorEventsPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session event live ledger routing", () => {
  test("preserves the V1 command stream while the V2 gate is closed", () => {
    const root = temporaryRoot();
    const instanceId = "agent-v1-fixture";
    configureSession(root, instanceId, "native-v1-session");

    writeSessionEvent("command_start", {
      instance_id: instanceId,
      cmd_id: "cmd-v1",
      cmd: "acme agents status",
      intent: "inspect status",
    });

    const v1 = readFileSync(join(root, ".harnery/events.ndjson"), "utf8");
    expect(v1).toContain('"event_type":"command.start"');
  });

  test("records command spans only in V2 once a candidate exists", () => {
    const root = candidateRoot();
    const instanceId = "agent-v2-fixture";
    const nativeSession = "native-v2-session";
    configureSession(root, instanceId, nativeSession);
    const route = resolveLiveEventLedgerRouteV2(root);
    if (route.state !== "v2") throw new Error("expected V2 route");
    expect(
      recordLiveHookSignalV2({
        coordRoot: root,
        route,
        eventName: "session-start",
        payload: { session_id: nativeSession, raw: {} },
        adapter: "claude-code",
        instanceId,
      }).state,
    ).toBe("recorded");
    expect(
      recordLiveHookSignalV2({
        coordRoot: root,
        route,
        eventName: "user-prompt-submit",
        payload: { session_id: nativeSession, turn_id: "turn-1", prompt: "run it", raw: {} },
        adapter: "claude-code",
        instanceId,
      }).state,
    ).toBe("recorded");

    const secret = "do-not-retain-this-output";
    writeSessionEvent("command_start", {
      instance_id: instanceId,
      cmd_id: "cmd-v2",
      cmd: "acme agents status --json",
      intent: "inspect agents",
    });
    writeSessionEvent("output", {
      instance_id: instanceId,
      cmd_id: "cmd-v2",
      stream: "stdout",
      line: secret,
    });
    writeSessionEvent("command_end", {
      instance_id: instanceId,
      cmd_id: "cmd-v2",
      exit: 0,
      duration_ms: 25,
    });

    const commandEvents = readActiveLedgerV2(root)
      .events.map(({ event }) => event)
      .filter((event) => event.producer.component === "session-tee");
    expect(commandEvents.map((event) => event.event_type)).toEqual([
      "command.started",
      "command.output_observed",
      "command.completed",
    ]);
    expect(existsSync(join(root, ".harnery/events.ndjson"))).toBeFalse();
    expect(readFileSync(join(root, ".harnery/ledgers/v2/active.ndjson"), "utf8")).not.toContain(
      secret,
    );
  });
});

function configureSession(root: string, instanceId: string, sessionId: string): void {
  process.env.HARNERY_EVENTS_PATH = join(root, ".harnery/session-events.ndjson");
  const heartbeat = join(root, ".harnery/active", `${instanceId}.json`);
  mkdirSync(dirname(heartbeat), { recursive: true });
  writeFileSync(heartbeat, JSON.stringify({ session_id: sessionId, platform: "claude-code" }));
}

function candidateRoot(): string {
  const root = temporaryRoot();
  const keys = loadOrCreateFingerprintKeyStoreV2(root, () => new Date("2026-08-16T17:00:00.000Z"));
  const profile: CandidateProfileV2 = {
    initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
    contract_source_digest: sha256V2("contract"),
    harnery_commit: "fixture",
    host_repository_commit: "fixture",
    producer_build_ids: [liveEventV2BuildId("fixture")],
    adapter_capability_profile_digests: [
      `sha256:${adapterCapabilityProfileDigestV2("claude-code").slice(4)}`,
    ],
    config_digest: sha256V2("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keys.active_epoch_id,
    v1_terminal_digest: sha256V2("v1"),
    v1_terminal_bytes: 1,
    v1_terminal_rows: 1,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
  const manifest = buildCandidateGenesisManifestV2({
    profile,
    root_id: "root_fixture",
    instance_id: "inst_cutover",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      build_id: "build_fixture",
      platform: "linux",
    },
  });
  const path = join(root, EVENT_V2_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV2(manifest)}\n`, { mode: 0o600 });
  return root;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-session-events-routing-"));
  roots.push(root);
  return root;
}
