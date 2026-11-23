import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { readLiveCoordinationRows } from "../agents/state/live-coordination-view.ts";
import { canonicalJsonV3, sha256V3 } from "../events/v3/canonical.ts";
import { adapterCapabilityProfileDigestV3 } from "../events/v3/capabilities.ts";
import {
  buildCandidateGenesisManifestV3,
  EVENT_V3_GENESIS_MANIFEST,
} from "../events/v3/control.ts";
import { repairEventV3ControlPair } from "../events/v3/control-writer.ts";
import { loadOrCreateFingerprintKeyStoreV3 } from "../events/v3/fingerprint-keys.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../events/v3/generated.ts";
import type { ScheduleHeartbeat, ScheduleRunRecord } from "../schedule/job-types.ts";
import {
  scheduleHeartbeatPath,
  scheduleObservedPath,
  scheduleRunDir,
  scheduleRunRecordPath,
  scheduleRunStamp,
} from "../schedule/paths.ts";

const HARNERY_DIR = resolve(import.meta.dir, "../../..");
const AGENT_HOOK = join(HARNERY_DIR, "bin", "agent-hook");
const HOOK_ENTRY = join(HARNERY_DIR, "src", "core", "hooks", "cli.ts");
const PROMPT = "SECRET-PROMPT-TEXT check the night";
const roots: string[] = [];

setDefaultTimeout(process.platform === "win32" ? 90_000 : 20_000);

afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root, 30_000);
});

type Adapter = "claude-code" | "codex";

function candidateRoot(adapter: Adapter): string {
  const root = mkdtempSync(join(tmpdir(), "harn-hook-schedule-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  mkdirSync(join(root, ".harnery", "pid-map"), { recursive: true });
  writeFileSync(join(root, ".harnery", ".lock"), "");
  symlinkSync(HARNERY_DIR, join(root, "harnery"));
  const git = (args: string[]) => spawnSync("git", args, { cwd: root, stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);
  const keys = loadOrCreateFingerprintKeyStoreV3(root);
  const manifest = buildCandidateGenesisManifestV3({
    profile: {
      initial_schema_digest: EVENT_V3_SCHEMA_DIGEST,
      contract_source_digest: sha256V3("contract"),
      harnery_commit: "fixture",
      host_repository_commit: "fixture",
      producer_build_ids: ["build_fixture"],
      adapter_capability_profile_digests: [
        `sha256:${adapterCapabilityProfileDigestV3(adapter).slice(4)}`,
      ],
      config_digest: sha256V3("config"),
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keys.active_epoch_id,
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
  const manifestPath = join(root, EVENT_V3_GENESIS_MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV3ControlPair(root).state).toBe("candidate");
  return root;
}

function hook(
  root: string,
  adapter: Adapter,
  event: string,
  payload: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
): { stdout: string; status: number | null } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("HARNERY_AGENT_COORD") ||
      key.startsWith("HARNERY_SCHEDULE") ||
      key.startsWith("HARNERY_WORKFLOW") ||
      key.startsWith("HARNERY_ADMISSION") ||
      key.startsWith("CLAUDE_CODE_SESSION") ||
      key.startsWith("CURSOR_") ||
      key.startsWith("CODEX_") ||
      key === "T3CODE_THREAD_ID"
    ) {
      delete env[key];
    }
  }
  const native = process.platform === "win32";
  const result = spawnSync(
    native ? process.execPath : "bash",
    [native ? HOOK_ENTRY : AGENT_HOOK, event, "--adapter", adapter],
    {
      input: JSON.stringify(payload),
      cwd: root,
      encoding: "utf8",
      env: {
        ...env,
        HARNERY_COORD_ROOT_OVERRIDE: root,
        HARNERY_AGENT_COORD_BYPASS_STOP: "1",
        ...extraEnv,
      },
    },
  );
  return { stdout: result.stdout ?? "", status: result.status };
}

function base(adapter: Adapter, session: string, root: string): Record<string, unknown> {
  return adapter === "codex"
    ? { session_id: session, thread_id: session, turn_id: `${session}-turn`, cwd: root }
    : { session_id: session, cwd: root };
}

function t3Call(adapter: Adapter, session: string, root: string): Record<string, unknown> {
  const tool = adapter === "codex" ? "mcp__t3_code__schedule_task" : "mcp__t3-code__schedule_task";
  const result = {
    scheduledTaskId: "scheduled-task:e1a523a6-41b6-4205-8d71-b22491f76a22",
    title: "Nightly look",
    prompt: PROMPT,
    enabled: false,
    schedule: { type: "once", runAt: "2027-01-01T12:00:00.000Z" },
    nextRunAt: null,
    lastRunStatus: "never",
  };
  return {
    ...base(adapter, session, root),
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_use_id: `${session}-tool`,
    tool_input: {
      title: "Nightly look",
      prompt: PROMPT,
      enabled: false,
      schedule: { type: "once", runAt: "2027-01-01T12:00:00.000Z" },
    },
    tool_response:
      adapter === "codex"
        ? { content: [{ type: "text", text: JSON.stringify(result) }] }
        : JSON.stringify(result),
  };
}

function observedLines(root: string): string[] {
  const path = scheduleObservedPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

function writeFailedRun(root: string): void {
  const started = new Date(Date.now() - 10 * 60_000).toISOString();
  const run: ScheduleRunRecord = {
    schema_version: 1,
    run_id: "run-1",
    job_id: "nightly-check",
    scheduled_for: started,
    kind: "scheduled",
    started_at: started,
    finished_at: new Date(Date.now() - 9 * 60_000).toISOString(),
    result: "failed",
    gather: [],
    agent: null,
    report_file: "report.md",
  };
  const path = scheduleRunRecordPath(
    scheduleRunDir(root, "nightly-check", scheduleRunStamp(started)),
  );
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(run));
}

/** A fresh heartbeat closes the activity throttle, so no tick is spawned. */
function writeFreshHeartbeat(root: string): void {
  const now = new Date().toISOString();
  const heartbeat: ScheduleHeartbeat = {
    schema_version: 1,
    last_tick_at: now,
    last_tick_status: "ok",
    last_ok_at: now,
    source: "activity",
  };
  const path = scheduleHeartbeatPath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(heartbeat));
}

describe("agent-hook schedule wiring", () => {
  for (const adapter of ["claude-code", "codex"] as const) {
    test(`captures a T3 Code schedule_task call from ${adapter}`, () => {
      const root = candidateRoot(adapter);
      const session = `schedule-capture-${adapter}`;
      expect(
        hook(root, adapter, "session-start", { ...base(adapter, session, root), source: "startup" })
          .status,
      ).toBe(0);
      const instanceId = readLiveCoordinationRows(root)[0]?.instance_id;
      expect(instanceId).toBeString();

      expect(hook(root, adapter, "post-tool-use", t3Call(adapter, session, root)).status).toBe(0);

      const lines = observedLines(root);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain("SECRET-PROMPT-TEXT");
      const observation = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
      expect(observation.instance_id).toBe(instanceId);
      expect(observation.operation).toBe("create");
      expect(observation.native_id).toBe("scheduled-task:e1a523a6-41b6-4205-8d71-b22491f76a22");
      expect(observation.title).toBe("Nightly look");
    });
  }

  test("an unrelated tool call writes no schedule state", () => {
    const root = candidateRoot("claude-code");
    const session = "schedule-unrelated";
    hook(root, "claude-code", "session-start", {
      session_id: session,
      cwd: root,
      source: "startup",
    });
    const result = hook(root, "claude-code", "post-tool-use", {
      session_id: session,
      cwd: root,
      tool_name: "Bash",
      tool_use_id: "ordinary",
      tool_input: { command: "true" },
      tool_response: "ok",
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(root, ".harnery", "private", "schedule"))).toBeFalse();
  });

  test("session start prints the cue for a failed run, and nothing without schedule state", () => {
    const quiet = candidateRoot("claude-code");
    const plain = hook(quiet, "claude-code", "session-start", {
      session_id: "schedule-quiet",
      cwd: quiet,
      source: "startup",
    });
    expect(plain.status).toBe(0);
    expect(plain.stdout).not.toContain("schedule");
    expect(existsSync(join(quiet, ".harnery", "private", "schedule"))).toBeFalse();

    const root = candidateRoot("claude-code");
    writeFailedRun(root);
    writeFreshHeartbeat(root);
    const result = hook(root, "claude-code", "session-start", {
      session_id: "schedule-cue",
      cwd: root,
      source: "startup",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nightly-check");
    expect(result.stdout).toContain("schedule history nightly-check");
  });

  test("a scheduled run's child skips capture, the cue and the tick", async () => {
    const root = candidateRoot("claude-code");
    writeFailedRun(root);
    const child = { HARNERY_SCHEDULE_CHILD: "1" };
    const session = "schedule-child";
    const start = hook(
      root,
      "claude-code",
      "session-start",
      { session_id: session, cwd: root, source: "startup" },
      child,
    );
    expect(start.status).toBe(0);
    expect(start.stdout).not.toContain("nightly-check");
    hook(
      root,
      "claude-code",
      "user-prompt-submit",
      { session_id: session, cwd: root, prompt: "hi" },
      child,
    );
    expect(
      hook(root, "claude-code", "post-tool-use", t3Call("claude-code", session, root), child)
        .status,
    ).toBe(0);
    expect(observedLines(root)).toHaveLength(0);
    // The throttle was open (no heartbeat); a spawned tick would write one.
    await Bun.sleep(1_500);
    expect(existsSync(scheduleHeartbeatPath(root))).toBeFalse();
  });
});
