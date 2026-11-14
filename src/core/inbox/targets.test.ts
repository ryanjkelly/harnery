import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { resolveMachineLabel } from "../../lib/machine.ts";
import { recordLiveLifecycleChangeV3 } from "../agents/live-authority-v3.ts";
import { readLiveCoordinationRows } from "../agents/state/live-coordination-view.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import { EVENT_V3_GENESIS_MANIFEST } from "../events/v3/control.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { resolveLiveEventLedgerRouteV3 } from "../events/v3/live-routing.ts";
import {
  readHookProducerStateV3,
  recordApprovedSessionEndV3,
  recordHookSignalV3,
} from "../events/v3/producers/recorder.ts";
import { sanitizeRefComponent } from "../presence/git.ts";
import { resolveMessageTarget } from "./targets.ts";

const roots: string[] = [];
const timestamp = "2026-08-28T22:00:00.000Z";
const later = new Date("2026-08-28T22:30:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "harnery-message-targets-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture",
    configDigest: sha256V3("fixture"),
    approvalRecordId: "message-target-fixture",
  });
  return root;
}

function session(root: string, instanceId: string, name: string, observedAt = timestamp) {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("fixture requires V3");
  expect(
    recordHookSignalV3({
      coordRoot: root,
      mode: route.mode,
      signal: "session-start",
      payload: { session_id: instanceId, raw: {} },
      adapter: "codex",
      instance_id: `inst_${instanceId}`,
      producer_id: "prd_message-target-fixture",
      build_id: route.build_id,
      platform: "linux",
      observed_at: observedAt,
    }).state,
  ).toBe("recorded");
  appendFileSync(
    join(root, ".harnery/.name-history"),
    JSON.stringify({
      instance_id: instanceId,
      name,
      kind: "session",
      ts: observedAt,
    }) + "\n",
  );
}

function endSession(root: string, instanceId: string) {
  const route = resolveLiveEventLedgerRouteV3(root);
  const state = readHookProducerStateV3(root, "codex", instanceId);
  if (route.state !== "v3" || !state) throw new Error("fixture requires a known generation");
  expect(
    recordApprovedSessionEndV3({
      coordRoot: root,
      mode: route.mode,
      instance_id: state.instance_id,
      generation_id: state.generation_id,
      build_id: route.build_id,
      platform: "linux",
      reason: "approved_explicit_end",
      outcome: "succeeded",
      coordination_finalized: true,
    }).state,
  ).toBe("recorded");
}

describe("durable message targets", () => {
  test("an exact generation expectation cannot select a later instance generation", () => {
    const root = fixture();
    session(root, "generation-bound", "Maya");
    const view = readCoordinationViewV3(root);
    const generation = view.instances["inst_generation-bound"]!.generation_id;
    expect(
      resolveMessageTarget(
        root,
        { instanceId: "generation-bound", generationId: generation, now: later },
        { view },
      ),
    ).toMatchObject({ ok: true, target: { instance_id: "generation-bound" } });
    expect(
      resolveMessageTarget(
        root,
        { instanceId: "generation-bound", generationId: "gen_other", now: later },
        { view },
      ),
    ).toMatchObject({ ok: false, code: "generation_mismatch" });
  });
  test("a thirty-minute-stale active generation queues without changing presence", () => {
    const root = fixture();
    session(root, "stale-active", "Maya");
    const before = readLiveCoordinationRows(root);
    expect(resolveMessageTarget(root, { name: "agent-maya", now: later })).toMatchObject({
      ok: true,
      target: { instance_id: "stale-active", name: "Maya", delivery: "queued" },
    });
    expect(readLiveCoordinationRows(root)).toEqual(before);
    expect(existsSync(join(root, ".harnery/active/stale-active.json"))).toBe(false);
  });

  test("a fresh exact name explicitly reports written-live", () => {
    const root = fixture();
    session(root, "fresh", "Maya");
    expect(
      resolveMessageTarget(root, { name: "Maya", now: new Date(timestamp), requireLive: true }),
    ).toMatchObject({
      ok: true,
      target: { instance_id: "fresh", delivery: "written-live" },
    });
    expect(resolveMessageTarget(root, { name: "May", now: new Date(timestamp) })).toMatchObject({
      ok: false,
      code: "no_peer",
    });
  });

  test("require-live refuses stale targets while ordinary delivery remains queued", () => {
    const root = fixture();
    session(root, "stale", "Maya");
    expect(
      resolveMessageTarget(root, { name: "Maya", now: later, requireLive: true }),
    ).toMatchObject({ ok: false, code: "not_live" });
    expect(resolveMessageTarget(root, { instanceId: "stale", now: later })).toMatchObject({
      ok: true,
      target: { instance_id: "stale", delivery: "queued" },
    });
  });

  test("task lifecycle done remains addressable after presence freshness expires", () => {
    const root = fixture();
    session(root, "completed-task", "Maya");
    recordLiveLifecycleChangeV3({
      coordRoot: root,
      owner: "completed-task",
      nativeSessionId: "completed-task",
      adapter: "codex",
      state: "done",
    });
    expect(
      resolveMessageTarget(root, { name: "Maya", now: new Date(Date.now() + 30 * 60_000) }),
    ).toMatchObject({
      ok: true,
      target: { instance_id: "completed-task", delivery: "queued" },
    });
  });

  test("a fully ended known instance queues without reviving its lifecycle", () => {
    const root = fixture();
    session(root, "ended-task", "Maya");
    endSession(root, "ended-task");
    expect(readLiveCoordinationRows(root)).toEqual([]);
    expect(resolveMessageTarget(root, { name: "Maya" })).toMatchObject({
      ok: true,
      target: { instance_id: "ended-task", delivery: "queued" },
    });
    expect(
      resolveMessageTarget(root, { instanceId: "ended-task", requireLive: true }),
    ).toMatchObject({ ok: false, code: "not_live" });
    expect(readLiveCoordinationRows(root)).toEqual([]);
  });

  test("a fresh holder wins over an older namesake while exact IDs retain the old address", () => {
    const root = fixture();
    session(root, "old-instance", "Maya");
    session(root, "current-instance", "Maya", later.toISOString());
    expect(resolveMessageTarget(root, { name: "Maya", now: later })).toMatchObject({
      ok: true,
      target: { instance_id: "current-instance", delivery: "written-live" },
    });
    expect(
      resolveMessageTarget(root, { name: "Maya", instanceId: "old-instance", now: later }),
    ).toMatchObject({
      ok: true,
      target: { instance_id: "old-instance", delivery: "queued" },
    });
  });

  test("ambiguous fresh and stale names refuse until an exact instance is supplied", () => {
    const root = fixture();
    session(root, "second-instance", "Maya");
    session(root, "first-instance", "Maya");
    expect(resolveMessageTarget(root, { name: "Maya", now: later })).toMatchObject({
      ok: false,
      code: "ambiguous_peer",
      candidates: ["first-instance", "second-instance"],
    });
    expect(resolveMessageTarget(root, { name: "Maya", now: new Date(timestamp) })).toMatchObject({
      ok: false,
      code: "ambiguous_peer",
    });
    expect(
      resolveMessageTarget(root, { name: "Maya", instanceId: "inst_first-instance", now: later }),
    ).toMatchObject({
      ok: true,
      target: { instance_id: "first-instance" },
    });
    expect(
      resolveMessageTarget(root, { name: "Other", instanceId: "first-instance", now: later }),
    ).toMatchObject({ ok: false, code: "no_peer" });
  });

  test("reused terminal names remain ambiguous and bind by exact historical instance", () => {
    const root = fixture();
    session(root, "ended-one", "Maya");
    endSession(root, "ended-one");
    session(root, "ended-two", "Maya");
    endSession(root, "ended-two");
    expect(resolveMessageTarget(root, { name: "Maya" })).toMatchObject({
      ok: false,
      code: "ambiguous_peer",
      candidates: ["ended-one", "ended-two"],
    });
    expect(resolveMessageTarget(root, { instanceId: "ended-one" })).toMatchObject({
      ok: true,
      target: { instance_id: "ended-one", delivery: "queued" },
    });
  });

  test("a pool name or unbacked history row never creates an address", () => {
    const root = fixture();
    appendFileSync(
      join(root, ".harnery/.name-history"),
      JSON.stringify({ instance_id: "unbacked", name: "Maya", kind: "session", ts: timestamp }) +
        "\n",
    );
    for (const input of [{ name: "Maya" }, { name: "Anna" }, { instanceId: "missing" }, {}]) {
      expect(resolveMessageTarget(root, input)).toMatchObject({ ok: false, code: "no_peer" });
    }
  });

  test("the latest durable name binding replaces the obsolete display name", () => {
    const root = fixture();
    session(root, "renamed", "Maya");
    appendFileSync(
      join(root, ".harnery/.name-history"),
      JSON.stringify({
        instance_id: "renamed",
        name: "Talia",
        kind: "session",
        ts: later.toISOString(),
      }) + "\n",
    );
    expect(resolveMessageTarget(root, { name: "Maya", now: later })).toMatchObject({
      ok: false,
      code: "no_peer",
    });
    expect(resolveMessageTarget(root, { name: "Talia", now: later })).toMatchObject({
      ok: true,
      target: { instance_id: "renamed", name: "Talia" },
    });
  });

  test("unavailable or corrupt authority fails closed without rewriting history", () => {
    const root = fixture();
    session(root, "safe-before-corruption", "Maya");
    const history = readFileSync(join(root, ".harnery/.name-history"));
    writeFileSync(join(root, EVENT_V3_GENESIS_MANIFEST), "{invalid control fixture");
    expect(resolveMessageTarget(root, { name: "Maya", now: later })).toMatchObject({
      ok: false,
      code: "authority_unsafe",
    });
    expect(readFileSync(join(root, ".harnery/.name-history"))).toEqual(history);
    expect(resolveMessageTarget(root, { name: "Maya", now: new Date(Number.NaN) })).toMatchObject({
      ok: false,
      code: "authority_unsafe",
    });
  });
});

function remote(root: string, machine: string, instanceId = `session-${machine}`, ageSecs = 0) {
  const directory = join(root, ".harnery", "presence", "remote");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${machine}.json`),
    JSON.stringify({
      v: 1,
      machine,
      published_at: new Date(Date.now() - ageSecs * 1000).toISOString(),
      agents: [
        { instance_id: instanceId, name: "Maya", activity: "working", task_state: "active" },
      ],
    }),
  );
}

describe("overlapping names across machines", () => {
  test("live remote wins over stale local, including require-live and ambiguous dormant history", () => {
    const root = fixture();
    session(root, "old-local", "Maya");
    remote(root, "peer-east");
    expect(
      resolveMessageTarget(root, { name: "agent-maya", now: later, requireLive: true }),
    ).toMatchObject({
      ok: true,
      target: { instance_id: "session-peer-east", machine: "peer-east", delivery: "remote" },
    });
    session(root, "another-old-local", "Maya");
    expect(resolveMessageTarget(root, { name: "Maya", now: later })).toMatchObject({
      ok: true,
      target: { machine: "peer-east" },
    });
  });

  test("fresh local wins over several live remote namesakes and explains explicit addresses", () => {
    const root = fixture();
    session(root, "local", "Maya", new Date().toISOString());
    remote(root, "peer-east");
    remote(root, "peer-west");
    expect(resolveMessageTarget(root, { name: "Maya" })).toMatchObject({
      ok: true,
      target: {
        instance_id: "local",
        delivery: "written-live",
        local_machine: sanitizeRefComponent(resolveMachineLabel()),
        remote_namesakes: [
          { machine: "peer-east", address: "Maya@peer-east" },
          { machine: "peer-west", address: "Maya@peer-west" },
        ],
        routing_note: expect.stringContaining("Maya@peer-east"),
      },
    });
  });

  test("dormant local retains the message when the remote name is also dormant", () => {
    const root = fixture();
    session(root, "local", "Maya");
    remote(root, "peer-east", "remote", 3600);
    expect(resolveMessageTarget(root, { name: "Maya", now: later })).toMatchObject({
      ok: true,
      target: { instance_id: "local", delivery: "queued", local_machine: expect.any(String) },
    });
    remote(root, "peer-west", "other-remote", 3600);
    expect(resolveMessageTarget(root, { name: "Maya", now: later })).toMatchObject({
      ok: true,
      target: { instance_id: "local", delivery: "queued" },
    });
  });

  test("an unused local name resolves remote live or dormant, but an unused name everywhere refuses", () => {
    const root = fixture();
    remote(root, "peer-east");
    expect(resolveMessageTarget(root, { name: "Maya" })).toMatchObject({
      ok: true,
      target: { machine: "peer-east" },
    });
    remote(root, "peer-east", "session-peer-east", 3600);
    expect(resolveMessageTarget(root, { name: "Maya" })).toMatchObject({
      ok: true,
      target: { machine: "peer-east" },
    });
    expect(resolveMessageTarget(root, { name: "Maya", requireLive: true })).toMatchObject({
      ok: false,
      code: "not_live",
    });
    expect(resolveMessageTarget(root, { name: "NeverUsed" })).toMatchObject({
      ok: false,
      code: "no_peer",
    });
  });

  test("machine-qualified names select local or remote explicitly, including dormant recipients", () => {
    const root = fixture();
    session(root, "local", "Maya");
    remote(root, "peer-east");
    const local = sanitizeRefComponent(resolveMachineLabel());
    expect(resolveMessageTarget(root, { name: `Maya@${local}`, now: later })).toMatchObject({
      ok: true,
      target: { instance_id: "local", delivery: "queued", local_machine: local },
    });
    expect(resolveMessageTarget(root, { name: "agent-maya@PEER-EAST", now: later })).toMatchObject({
      ok: true,
      target: { instance_id: "session-peer-east", machine: "peer-east" },
    });
    expect(resolveMessageTarget(root, { name: "Maya@missing" })).toMatchObject({
      ok: false,
      code: "no_peer",
    });
    remote(root, "peer-east", "session-peer-east", 3600);
    expect(resolveMessageTarget(root, { name: "Maya@peer-east" })).toMatchObject({
      ok: true,
      target: { machine: "peer-east" },
    });
    expect(resolveMessageTarget(root, { name: "Maya@peer-east", requireLive: true })).toMatchObject(
      { ok: false, code: "not_live" },
    );
  });

  test("exact local instance and generation addressing cannot be rerouted by a remote name", () => {
    const root = fixture();
    session(root, "local", "Maya");
    remote(root, "peer-east");
    const view = readCoordinationViewV3(root);
    expect(
      resolveMessageTarget(root, { name: "Maya", instanceId: "local", now: later }),
    ).toMatchObject({
      ok: true,
      target: { instance_id: "local", delivery: "queued" },
    });
    expect(
      resolveMessageTarget(root, {
        name: "Maya",
        generationId: view.instances.inst_local!.generation_id,
        now: later,
      }),
    ).toMatchObject({ ok: true, target: { instance_id: "local", delivery: "queued" } });
  });

  test("two remote live namesakes require a machine address even when their instance IDs match", () => {
    const root = fixture();
    session(root, "old-local", "Maya");
    remote(root, "peer-east", "shared-id");
    remote(root, "peer-west", "shared-id");
    expect(resolveMessageTarget(root, { name: "Maya", now: later })).toMatchObject({
      ok: false,
      code: "ambiguous_peer",
    });
    expect(resolveMessageTarget(root, { instanceId: "shared-id" })).toMatchObject({
      ok: false,
      code: "ambiguous_peer",
    });
    expect(
      resolveMessageTarget(root, { name: "Maya@peer-west", instanceId: "shared-id" }),
    ).toMatchObject({
      ok: true,
      target: { machine: "peer-west", instance_id: "shared-id" },
    });
  });

  test("malformed qualified names fail without falling back to another destination", () => {
    const root = fixture();
    session(root, "local", "Maya");
    for (const name of ["Maya@", "@peer-east", "Maya@peer@east"]) {
      expect(resolveMessageTarget(root, { name })).toMatchObject({ ok: false, code: "no_peer" });
    }
  });
});
