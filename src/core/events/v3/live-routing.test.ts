import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "./capabilities.ts";
import type { EventV3 } from "./contract.ts";
import {
  buildCandidateGenesisManifestV3,
  type CandidateProfileV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "./control.ts";
import { readCoordinationViewV3 } from "./coordination-view.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "./fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";
import { observeLiveEventLedgerRouteV3 } from "./live-route-observer.ts";
import {
  hookSignalV3,
  liveEventV3BuildId,
  liveHookSignalDefersDrainV3,
  liveInstanceIdV3,
  recordLiveDelegatedChildSessionV3,
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "./live-routing.ts";
import { readLedgerV3 } from "./reader.ts";
import { eventV3Paths } from "./writer.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("live V3 ledger routing", () => {
  test("maps Cursor shell fallbacks onto canonical tool signals", () => {
    expect(hookSignalV3("before-shell-execution")).toBe("pre-tool-use");
    expect(hookSignalV3("after-shell-execution")).toBe("post-tool-use");
  });

  test("defers only tool lifecycle hooks to the next ledger boundary", () => {
    expect(liveHookSignalDefersDrainV3("pre-tool-use")).toBeTrue();
    expect(liveHookSignalDefersDrainV3("post-tool-use")).toBeTrue();
    expect(liveHookSignalDefersDrainV3("post-tool-use-failure")).toBeTrue();
    expect(liveHookSignalDefersDrainV3("before-shell-execution")).toBeTrue();
    expect(liveHookSignalDefersDrainV3("after-shell-execution")).toBeTrue();
    expect(liveHookSignalDefersDrainV3("user-prompt-submit")).toBeFalse();
    expect(liveHookSignalDefersDrainV3("stop")).toBeFalse();
    expect(liveHookSignalDefersDrainV3("session-end")).toBeFalse();
    expect(liveHookSignalDefersDrainV3("stop", "1")).toBeTrue();
    expect(liveHookSignalDefersDrainV3("pre-tool-use", "0")).toBeFalse();
  });

  test("blocks an uninitialized root", () => {
    expect(resolveLiveEventLedgerRouteV3(temporaryRoot())).toEqual({
      state: "blocked",
      reason: "v3_not_initialized",
    });
  });

  test("repairs a candidate packet and records through the canonical route", () => {
    const root = candidateRoot("claude-code");
    const route = resolveLiveEventLedgerRouteV3(root);
    expect(route).toMatchObject({ state: "v3", mode: "candidate", build_id: "build_fixture" });
    if (route.state !== "v3") throw new Error("expected V3 route");

    const result = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { session_id: "native-session", raw: {} },
      adapter: "claude-code",
      instanceId: "agent-Helene",
    });

    expect(result.state).toBe("recorded");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "user-prompt-submit",
        payload: { session_id: "native-session", prompt: "continue", raw: {} },
        adapter: "claude-code",
        instanceId: "agent-Helene",
      }).state,
    ).toBe("recorded");
    const ledger = readLedgerV3(root);
    expect(ledger).toMatchObject({ complete: true, diagnostics: [] });
    expect(
      ledger.events
        .filter(({ event }) => event.producer.producer_id === "prd_agent-hook")
        .every(({ event }) => event.time.monotonic_ns === undefined),
    ).toBeTrue();
    expect(liveInstanceIdV3("agent-Helene")).toBe("inst_agent-Helene");
  });

  test("passive observation fails closed without repairing a control pair", () => {
    const root = candidateRoot("claude-code");
    const activePath = eventV3Paths(root).active;

    expect(existsSync(activePath)).toBeFalse();
    expect(observeLiveEventLedgerRouteV3(root)).toEqual({
      state: "blocked",
      reason: "repairable:genesis_event_missing",
    });
    expect(existsSync(activePath)).toBeFalse();

    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({
      state: "v3",
      mode: "candidate",
      build_id: "build_fixture",
    });
    expect(existsSync(activePath)).toBeTrue();
  });

  test("keeps deferred tool events durable until a non-tool hook publishes the batch", () => {
    const root = candidateRoot("codex");
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const sessionId = "batched-tool-session";
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-start",
        payload: { session_id: sessionId, raw: {} },
        adapter: "codex",
        instanceId: sessionId,
      }).state,
    ).toBe("recorded");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "user-prompt-submit",
        payload: { session_id: sessionId, prompt: "read fixture", raw: {} },
        adapter: "codex",
        instanceId: sessionId,
      }).state,
    ).toBe("recorded");

    const toolPayload = {
      session_id: sessionId,
      tool_name: "Read",
      tool_use_id: "batched-read",
      tool_input: { file_path: "fixture.txt" },
      raw: {},
    };
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "pre-tool-use",
        payload: toolPayload,
        adapter: "codex",
        instanceId: sessionId,
        defer_drain: true,
      }).state,
    ).toBe("recorded");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "post-tool-use",
        payload: { ...toolPayload, tool_response: "fixture line" },
        adapter: "codex",
        instanceId: sessionId,
        defer_drain: true,
      }).state,
    ).toBe("recorded");

    expect(
      readLedgerV3(root).events.some(({ event }) => event.event_type.startsWith("tool.")),
    ).toBeFalse();
    expect(
      readdirSync(eventV3Paths(root).spool).filter((name) => name.endsWith(".ready")),
    ).toHaveLength(2);

    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "stop",
        payload: { session_id: sessionId, raw: {} },
        adapter: "codex",
        instanceId: sessionId,
      }).state,
    ).toBe("recorded");
    const eventTypes = readLedgerV3(root).events.map(({ event }) => event.event_type);
    expect(eventTypes.filter((eventType) => eventType === "tool.requested")).toHaveLength(1);
    expect(eventTypes.filter((eventType) => eventType === "tool.completed")).toHaveLength(1);
    expect(
      readdirSync(eventV3Paths(root).spool).filter((name) => name.endsWith(".ready")),
    ).toHaveLength(0);
  });

  test("refuses an unsupported Cursor signal", () => {
    const root = candidateRoot("cursor");
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const started = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { conversation_id: "cursor-session", raw: {} },
      adapter: "cursor",
      instanceId: "cursor-session",
    });
    expect(started.state).toBe("recorded");

    const ended = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "post-compact",
      payload: { conversation_id: "cursor-session", raw: {} },
      adapter: "cursor",
      instanceId: "cursor-session",
    });
    expect(ended).toEqual({
      state: "gate_closed",
      reason: "signal_not_approved:post_compaction",
    });
  });

  test("opens the minted child generation and routes its tools away from the parent", () => {
    const root = candidateRoot("codex");
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    const parent = "codex-parent";
    const child = "codex-child";
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "session-start",
        payload: { session_id: parent, raw: {} },
        adapter: "codex",
        instanceId: parent,
      }).state,
    ).toBe("recorded");
    const nativeStart = recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "sub-agent-start",
      payload: {
        session_id: parent,
        agent_id: child,
        raw: { agent_type: "explorer" },
      },
      adapter: "codex",
      instanceId: parent,
    });
    if (nativeStart.state !== "recorded" || nativeStart.event.event_type !== "agent.started") {
      throw new Error("native child start missing");
    }
    expect(
      recordLiveDelegatedChildSessionV3({
        coordRoot: root,
        route,
        parentEvent: nativeStart.event,
        payload: {
          session_id: parent,
          agent_id: child,
          turn_id: "child-turn",
          raw: { agent_type: "explorer" },
        },
        adapter: "codex",
      }).state,
    ).toBe("recorded");
    expect(
      recordLiveHookSignalV3({
        coordRoot: root,
        route,
        eventName: "pre-tool-use",
        payload: {
          session_id: parent,
          agent_id: child,
          tool_name: "Bash",
          tool_use_id: "child-tool",
          tool_input: { command: "harn agents whoami" },
          raw: {},
        },
        adapter: "codex",
        instanceId: child,
      }).state,
    ).toBe("recorded");

    const events = readLedgerV3(root).events.map(({ event }) => event);
    const starts = events.filter(
      (event): event is Extract<EventV3, { event_type: "session.started" }> =>
        event.event_type === "session.started",
    );
    const childGeneration = nativeStart.event.payload.child_generation_id as `gen_${string}`;
    const childStart = starts.find(
      (event) =>
        (event.scope as { generation_id?: `gen_${string}` }).generation_id === childGeneration,
    );
    const childTool = events.find((event) => event.event_type === "tool.requested");
    const childTurn = events.find(
      (event) =>
        event.event_type === "turn.started" &&
        (event.scope as { generation_id?: `gen_${string}` }).generation_id === childGeneration,
    );
    expect(starts).toHaveLength(2);
    expect(childStart?.links).toMatchObject({
      parent_generation_id: (nativeStart.event.links as { parent_generation_id?: `gen_${string}` })
        .parent_generation_id,
      delegation_id: nativeStart.event.payload.delegation_id,
    });
    expect(childTool?.scope).toMatchObject({
      instance_id: liveInstanceIdV3(child),
      generation_id: childGeneration,
    });
    expect(childTurn?.provenance).toMatchObject({
      source_event: "codex.subagent-start.child-turn",
      attestation: "derived",
      confidence: "high",
    });
    expect(new Set(Object.keys(readCoordinationViewV3(root).instances))).toEqual(
      new Set([liveInstanceIdV3(child), liveInstanceIdV3(parent)]),
    );
  });

  test("blocks a candidate that did not approve the live producer build", () => {
    const root = candidateRoot("claude-code", ["build_other"]);
    expect(resolveLiveEventLedgerRouteV3(root)).toEqual({
      state: "blocked",
      reason: "live_producer_build_not_approved",
    });
  });

  test("candidate rollback blocks producers and restores the exact packet", () => {
    const root = candidateRoot("claude-code");
    expect(resolveLiveEventLedgerRouteV3(root).state).toBe("v3");
    const current = eventV3Paths(root).root;
    const parked = `${current}.rollback-rehearsal`;

    renameSync(current, parked);
    expect(resolveLiveEventLedgerRouteV3(root)).toEqual({
      state: "blocked",
      reason: "v3_not_initialized",
    });
    renameSync(parked, current);
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({
      state: "v3",
      mode: "candidate",
      build_id: "build_fixture",
    });
  });
});

function candidateRoot(
  adapter: "claude-code" | "cursor" | "codex",
  builds: string[] = [liveEventV3BuildId("fixture")],
): string {
  const root = temporaryRoot();
  const keys = loadOrCreateFingerprintKeyStoreV3(root, () => new Date("2026-08-16T17:00:00.000Z"));
  const profile: CandidateProfileV3 = {
    initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
    contract_source_digest: sha256V3("contract"),
    harnery_commit: "fixture",
    host_repository_commit: "fixture",
    producer_build_ids: builds,
    adapter_capability_profile_digests: [
      `sha256:${adapterCapabilityProfileDigestV3(adapter).slice(4)}`,
    ],
    config_digest: sha256V3("config"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: keys.active_epoch_id,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
  const manifest = buildCandidateGenesisManifestV3({
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
  const path = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  return root;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-live-routing-"));
  roots.push(root);
  return root;
}
