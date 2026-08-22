import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import { ensureLiveCoordinationHeartbeat } from "../core/agents/state/live-coordination-view.ts";
import { canonicalJsonV3, sha256V3 } from "../core/events/v3/canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../core/events/v3/capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  EVENT_V3_GENESIS_MANIFEST,
  repairEventV3ControlPair,
} from "../core/events/v3/control.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../core/events/v3/fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../core/events/v3/generated.ts";
import { liveInstanceIdV3 } from "../core/events/v3/live-routing.ts";
import { recordHookSignalV3 } from "../core/events/v3/producers/recorder.ts";
import { readLedgerV3 } from "../core/events/v3/reader.ts";
import { fileDecision, resolveDecision } from "../lib/decision/index.ts";

const roots: string[] = [];
const coordinationEnvKeys = [
  "HARNERY_COORD_ROOT_OVERRIDE",
  "HARNERY_AGENT_COORD_OWNER",
  "HARNERY_AGENT_COORD_PLATFORM",
  "HARNERY_AGENT_COORD_BRIDGE",
  "HARNERY_AGENT_COORD_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CURSOR_SESSION_ID",
  "CURSOR_CONVERSATION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;
const originalCoordinationEnv = new Map(
  coordinationEnvKeys.map((key) => [key, process.env[key]] as const),
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of coordinationEnvKeys) {
    const value = originalCoordinationEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-decision-cli-"));
  roots.push(root);
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  return root;
}

/** Run one CLI invocation and capture what it emitted.
 *
 * A refusal emits its error and then exits, so the emitted value is the thing
 * worth asserting on; whatever the process teardown throws afterwards is noise.
 * Swallowing the throw here keeps that distinction in one place. */
async function run(argv: string[]): Promise<{ data: unknown; error: unknown; threw: unknown }> {
  let data: unknown;
  let error: unknown;
  let threw: unknown;
  const emit: EmitContext = {
    data: (value: unknown) => {
      data = value;
    },
    error: (value: unknown) => {
      error = value;
    },
  } as unknown as EmitContext;
  const program = createHarneryProgram({ emit });
  try {
    await program.parseAsync(["node", "harn", ...argv]);
  } catch (e) {
    threw = e;
  }
  return { data, error, threw };
}

type Row = { decision_id: string; stakes: string; tier: number; filed_at: string };

describe("decision list --waiting", () => {
  test("returns only what a human still owes a ruling on", async () => {
    const root = fixture();
    // Tier 2 is the only tier that parks work; tier 0/1 already proceeded on a
    // default, which is exactly why they must not dilute this list.
    fileDecision(root, { question: "Ship the rewrite?", tier: 2, stakes: "high" });
    fileDecision(root, { question: "Name the flag?", tier: 1, stakes: "small" });
    fileDecision(root, { question: "Pick an idiom?", tier: 0, stakes: "small" });

    const { data } = await run(["decision", "list", "--waiting"]);
    const rows = (data as { rows: Row[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tier).toBe(2);
    expect((data as { meta: { filter: { waiting: boolean } } }).meta.filter.waiting).toBe(true);
  });

  test("a resolved tier 2 is no longer waiting on anyone", async () => {
    const root = fixture();
    const filed = fileDecision(root, {
      question: "Ship the rewrite?",
      tier: 2,
      stakes: "high",
    });
    const id = filed.manifest?.decision_id;
    if (!id) throw new Error("fixture decision was not filed");

    expect(
      ((await run(["decision", "list", "--waiting"])).data as { rows: Row[] }).rows,
    ).toHaveLength(1);

    // Assert the resolve landed. Without this the test can pass for the wrong
    // reason: a rejected resolution leaves the decision open, and "still open"
    // is indistinguishable from "the filter is broken".
    const resolved = resolveDecision(root, id, {
      recommendation: "Ship it",
      evidence: ["measured the rollback cost at under five minutes"],
      resolved_by: "operator",
    });
    expect(resolved.ok).toBe(true);

    const after = ((await run(["decision", "list", "--waiting"])).data as { rows: Row[] }).rows;
    expect(after).toHaveLength(0);
  });

  test("orders by stakes, then by how long it has gone unanswered", async () => {
    const root = fixture();
    // Filed newest-first on purpose: the default listing order is filed-desc, so
    // if the sort were not applied the old high-stakes entry would come last.
    const mk = (question: string, stakes: "high" | "medium", filedAt: string) => {
      const r = fileDecision(root, { question, tier: 2, stakes });
      const id = r.manifest?.decision_id;
      if (!id) throw new Error("fixture decision was not filed");
      // Backdate through the manifest so age is deterministic in the test.
      const path = join(root, ".harnery", "decisions", `${id}.json`);
      const m = JSON.parse(readFileSync(path, "utf8"));
      m.filed_at = filedAt;
      writeFileSync(path, JSON.stringify(m));
      return id;
    };
    const freshHigh = mk("Fresh but high", "high", "2026-08-01T00:00:00.000Z");
    const oldHigh = mk("Old and high", "high", "2026-07-01T00:00:00.000Z");
    const oldMedium = mk("Oldest of all, but medium", "medium", "2026-06-01T00:00:00.000Z");

    const rows = ((await run(["decision", "list", "--waiting"])).data as { rows: Row[] }).rows;
    // Stakes leads, so the medium sinks even though it is the oldest; within
    // equal stakes the one that has waited longest comes first.
    expect(rows.map((r) => r.decision_id)).toEqual([oldHigh, freshHigh, oldMedium]);
  });

  test("refuses a tier filter that contradicts --waiting instead of quietly winning", async () => {
    fixture();
    // This command's refusal path ends in process.exit, which would take the
    // test runner with it, so trade the exit for a throw just here and put it
    // back afterwards. Stubbing beats loosening the command: an operator who
    // typed a contradiction should be told, not silently overruled.
    const realExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;
    let error: unknown;
    let threw: unknown;
    try {
      ({ error, threw } = await run(["decision", "list", "--waiting", "--tier", "1"]));
    } finally {
      process.exit = realExit;
    }
    expect((error as { message?: string } | undefined)?.message).toMatch(/tier 2 by definition/);
    // And it really did stop rather than falling through to a listing.
    expect((threw as Error | undefined)?.message).toBe("exit:1");
  });
});

describe("decision V3 telemetry", () => {
  test("file and resolve join the hook generation through its native session ID", async () => {
    const owner = "decision-fixture";
    const nativeSession = "native-decision-session";
    const root = liveV3Fixture(owner, nativeSession);
    const realExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;

    try {
      const filed = await run([
        "decision",
        "file",
        "Choose the telemetry join?",
        "--tier",
        "0",
        "--stakes",
        "small",
        "--default-taken",
        "Use the native session",
      ]);
      expect(filed.error).toBeUndefined();
      expect(filed.threw).toBeUndefined();
      const decisionId = (filed.data as { decision_id?: string }).decision_id;
      if (!decisionId) throw new Error("decision file did not return an ID");

      const resolved = await run([
        "decision",
        "resolve",
        decisionId,
        "--recommendation",
        "Keep the native-session join",
        "--evidence",
        "the hook producer is keyed by the adapter session ID",
        "--resolved-by",
        "fixture-agent",
      ]);
      expect(resolved.error).toBeUndefined();
      expect(resolved.threw).toBeUndefined();

      const events = readLedgerV3(root)
        .events.map(({ event }) => event)
        .filter((event) => event.event_type === "decision.state_changed");
      expect(events.map((event) => event.payload.new_state)).toEqual(["filed", "resolved"]);
      const generationIds = events.map((event) => {
        if (!("generation_id" in event.scope)) throw new Error("decision event has no generation");
        return event.scope.generation_id;
      });
      expect(new Set(generationIds).size).toBe(1);
    } finally {
      process.exit = realExit;
    }
  });
});

function liveV3Fixture(owner: string, nativeSession: string): string {
  const root = fixture();
  for (const key of coordinationEnvKeys) {
    if (key !== "HARNERY_COORD_ROOT_OVERRIDE") delete process.env[key];
  }
  const keyStore = loadOrCreateFingerprintKeyStoreV3(root);
  const manifest = buildCandidateGenesisManifestV3({
    profile: {
      initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      contract_source_digest: sha256V3("contract"),
      harnery_commit: "fixture",
      host_repository_commit: "fixture",
      producer_build_ids: ["build_fixture"],
      adapter_capability_profile_digests: [
        `sha256:${adapterCapabilityProfileDigestV3("claude-code").slice(4)}`,
      ],
      config_digest: sha256V3("config"),
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keyStore.active_epoch_id,
      candidate_created_at: "2026-08-21T20:00:00.000Z",
    },
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
  const manifestPath = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV3ControlPair(root).state).toBe("candidate");

  const started = recordHookSignalV3({
    coordRoot: root,
    mode: "candidate",
    signal: "session-start",
    payload: { raw: {}, session_id: nativeSession, model: "sonnet" },
    adapter: "claude-code",
    instance_id: liveInstanceIdV3(owner),
    producer_id: "prd_hook",
    build_id: "build_fixture",
    platform: "linux",
    adapterVersion: "1.0.0",
    harnessVersion: "1.0.0",
  });
  expect(started.state).toBe("recorded");
  expect(
    ensureLiveCoordinationHeartbeat(root, owner, nativeSession, "claude-code", "sonnet"),
  ).not.toBeNull();

  process.env.HARNERY_AGENT_COORD_OWNER = owner;
  process.env.HARNERY_AGENT_COORD_PLATFORM = "claude-code";
  return root;
}
