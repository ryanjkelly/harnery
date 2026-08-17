import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  listSessionFinalizationRequestsV2,
  requestSessionEndExplicitV2,
} from "../agents/session-finalizer-v2.ts";
import { canonicalJsonV2, sha256V2 } from "../events/v2/canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../events/v2/capabilities.ts";
import {
  buildCandidateGenesisManifestV2,
  EVENT_V2_GENESIS_MANIFEST,
  repairEventV2ControlPair,
} from "../events/v2/control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../events/v2/fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../events/v2/generated.ts";
import { readHookProducerStateV2 } from "../events/v2/producers/recorder.ts";
import { readActiveLedgerV2 } from "../events/v2/reader.ts";

const HARNERY_DIR = resolve(import.meta.dir, "../../..");
const AGENT_HOOK = join(HARNERY_DIR, "bin", "agent-hook");
const AGENT_COORD = join(HARNERY_DIR, "bin", "agent-coord");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent-hook V2 hard cut", () => {
  test("candidate hooks append V2 without reading or mutating fenced V1 projection state", () => {
    const root = candidateRoot();
    const owner = "candidate-owner";
    const legacySelf = join(root, ".harnery", "active", `${owner}.json`);
    const legacyPeer = join(root, ".harnery", "active", "legacy-peer.json");
    const v1Ledger = join(root, ".harnery", "events.ndjson");
    const v1Cursor = join(root, ".harnery", ".events-cursor");
    const presenceState = join(root, ".harnery", "presence", "publish-state.json");
    writeFileSync(
      legacySelf,
      JSON.stringify({
        schema_version: 1,
        instance_id: owner,
        session_id: owner,
        name: "LEGACY_SELF_MUST_STAY_FENCED",
        suggested_session_name: "LEGACY_NAME_MUST_STAY_FENCED",
        session_name_seen_for: "LEGACY_NAME_MUST_STAY_FENCED",
        kind: "session",
        platform: "claude-code",
        started_at: "2026-08-16T18:00:00.000Z",
        last_heartbeat: "2026-08-16T18:00:00.000Z",
        files_touched: ["legacy-self.ts"],
      }),
    );
    writeFileSync(
      legacyPeer,
      JSON.stringify({
        schema_version: 1,
        instance_id: "legacy-peer",
        session_id: "another-group",
        name: "LEGACY_PEER_MUST_STAY_FENCED",
        task: "LEGACY_TASK_MUST_STAY_FENCED",
        kind: "session",
        platform: "claude-code",
        started_at: new Date().toISOString(),
        last_heartbeat: new Date().toISOString(),
        files_touched: ["legacy-peer.ts"],
      }),
    );
    writeFileSync(
      v1Ledger,
      `${JSON.stringify({
        schema_version: 1,
        event_id: "legacy-event",
        event_type: "session.start",
        ts: "2026-08-16T18:00:00.000Z",
        instance_id: owner,
        session_id: owner,
        adapter: "claude-code",
        source: "legacy-fixture",
        data: {},
      })}\n`,
    );
    writeFileSync(v1Cursor, "legacy-event\n");
    mkdirSync(dirname(presenceState), { recursive: true });
    writeFileSync(
      presenceState,
      JSON.stringify({ basis_hash: "legacy-presence", pushed_at: "2026-08-16T18:00:00Z" }),
    );
    const transcript = join(root, "transcript.jsonl");
    writeFileSync(
      transcript,
      `${JSON.stringify({
        timestamp: "2026-08-16T18:01:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "LEGACY_REPLAY_MUST_STAY_FENCED" },
      })}\n`,
    );

    const before = snapshot([legacySelf, legacyPeer, v1Ledger, v1Cursor, presenceState]);
    const outputs: string[] = [];
    const hook = (event: string, payload: Record<string, unknown>) => {
      const result = run(AGENT_HOOK, [event, "--adapter", "claude-code"], payload, root);
      expect(result.status).toBe(0);
      outputs.push(result.stdout, result.stderr);
    };

    hook("session-start", {
      session_id: owner,
      cwd: root,
      source: "startup",
      hook_event_name: "SessionStart",
    });
    const beforeFallbackProbe = readActiveLedgerV2(root).events.length;
    const fallbackProbe = run(
      AGENT_HOOK,
      ["user-prompt-submit", "--adapter", "claude-code"],
      { cwd: root, prompt: "must remain unattributed", hook_event_name: "UserPromptSubmit" },
      root,
      { HARNERY_AGENT_COORD_SESSION_ID: owner },
    );
    expect(fallbackProbe.status).toBe(0);
    expect(fallbackProbe.stdout).not.toContain("LEGACY_");
    expect(readActiveLedgerV2(root).events.length).toBe(beforeFallbackProbe);
    hook("user-prompt-submit", {
      session_id: owner,
      cwd: root,
      prompt: "continue",
      hook_event_name: "UserPromptSubmit",
    });
    hook("pre-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "echo candidate" },
      hook_event_name: "PreToolUse",
    });
    hook("post-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_input: { command: "echo candidate" },
      tool_response: "candidate",
      hook_event_name: "PostToolUse",
    });
    hook("post-tool-use-failure", {
      session_id: owner,
      cwd: root,
      tool_name: "Edit",
      tool_input: { file_path: join(root, "legacy-self.ts") },
      tool_response: "failed",
      hook_event_name: "PostToolUseFailure",
    });
    hook("stop", {
      session_id: owner,
      cwd: root,
      transcript_path: transcript,
      last_assistant_message: "done",
      hook_event_name: "Stop",
    });
    hook("session-end", {
      session_id: owner,
      cwd: root,
      reason: "exit",
      hook_event_name: "SessionEnd",
    });

    const replay = run(
      AGENT_COORD,
      ["codex-replay", "--jsonl", transcript, "--session", owner, "--owner", owner],
      {},
      root,
    );
    expect(replay.status).toBe(0);
    expect(JSON.parse(replay.stdout)).toMatchObject({ emitted: 0 });

    expect(snapshot([legacySelf, legacyPeer, v1Ledger, v1Cursor, presenceState])).toEqual(before);
    expect(outputs.join("\n")).not.toContain("LEGACY_");
    const ledger = readActiveLedgerV2(root);
    expect(ledger.complete).toBeTrue();
    expect(ledger.diagnostics).toEqual([]);
    expect(ledger.events.some(({ event }) => event.event_type === "session.started")).toBeTrue();
    expect(ledger.events.some(({ event }) => event.event_type === "session.ended")).toBeTrue();
    expect(ledger.events.length).toBeGreaterThan(2);
  });

  test("stop hook completes an explicit end queued by its own open tool span", () => {
    const root = candidateRoot();
    const owner = "deferred-end-owner";
    const hook = (event: string, payload: Record<string, unknown>) => {
      const result = run(AGENT_HOOK, [event, "--adapter", "claude-code"], payload, root);
      expect(result.status).toBe(0);
    };
    hook("session-start", { session_id: owner, cwd: root, source: "startup" });
    hook("user-prompt-submit", { session_id: owner, cwd: root, prompt: "finish" });
    hook("pre-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "end-tool",
      tool_input: { command: "harn agents status --end-turn --end-session" },
    });
    const state = readHookProducerStateV2(root, "claude-code", owner);
    if (!state) throw new Error("producer state missing");
    expect(
      requestSessionEndExplicitV2({
        coordRoot: root,
        instance_id: state.instance_id,
        generation_id: state.generation_id,
        coordination_finalized: true,
      }).state,
    ).toBe("queued");
    hook("post-tool-use", {
      session_id: owner,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "end-tool",
      tool_input: { command: "harn agents status --end-turn --end-session" },
      tool_response: "queued",
    });
    hook("stop", {
      session_id: owner,
      cwd: root,
      last_assistant_message: "done",
    });
    expect(readHookProducerStateV2(root, "claude-code", owner)?.terminal).toBeTrue();
    expect(listSessionFinalizationRequestsV2(root)[0]).toMatchObject({
      trigger: "explicit_end",
      status: "completed",
    });
    expect(
      readActiveLedgerV2(root).events.filter(({ event }) => event.event_type === "session.ended"),
    ).toHaveLength(1);
  });
});

function candidateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-hook-v2-route-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  mkdirSync(join(root, ".harnery", "pid-map"), { recursive: true });
  writeFileSync(join(root, ".harnery", ".lock"), "");
  symlinkSync(HARNERY_DIR, join(root, "harnery"));
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);

  const keys = loadOrCreateFingerprintKeyStoreV2(root);
  const manifest = buildCandidateGenesisManifestV2({
    profile: {
      initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
      contract_source_digest: sha256V2("contract"),
      harnery_commit: "fixture",
      host_repository_commit: "fixture",
      producer_build_ids: ["build_fixture"],
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
  const manifestPath = join(root, EVENT_V2_GENESIS_MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${canonicalJsonV2(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV2ControlPair(root).state).toBe("candidate");
  return root;
}

function run(
  bin: string,
  args: string[],
  payload: Record<string, unknown>,
  root: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const env = { ...process.env };
  for (const key of [
    "HARNERY_AGENT_COORD_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CURSOR_SESSION_ID",
    "CURSOR_CONVERSATION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
    "HARNERY_AGENT_COORD_OWNER",
    "HARNERY_AGENT_COORD_BRIDGE",
  ]) {
    delete env[key];
  }
  const result = spawnSync("bash", [bin, ...args], {
    input: Object.keys(payload).length > 0 ? JSON.stringify(payload) : "",
    cwd: root,
    encoding: "utf8",
    env: { ...env, HARNERY_COORD_ROOT_OVERRIDE: root, ...extraEnv },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function snapshot(paths: string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((path) => [path, existsSync(path) ? readFileSync(path, "utf8") : "<missing>"]),
  );
}
