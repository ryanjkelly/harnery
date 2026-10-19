import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recordLiveClaimChangeV3, recordLiveTaskChangeV3 } from "../agents/live-authority-v3.ts";
import { ensureLiveCoordinationHeartbeat } from "../agents/state/live-coordination-writer.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import { HarneryInboxService, inboxPath } from "../inbox/service.ts";
import {
  type ContinuityCapsule,
  checkpointContext,
  completeContextRecovery,
  extractContextSample,
  markContextCompactionCompleted,
  prepareContextRecovery,
  type RepoSnapshot,
  readContextState,
  readLatestCapsule,
  recordContextSample,
  recoverContext,
  renderRecoveryBriefing,
  repoComparisonProblems,
  snapshotRepo,
} from "./index.ts";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harnery-context-"));
  roots.push(value);
  mkdirSync(value, { recursive: true });
  initializeEventLedgerV3({
    coordRoot: value,
    harneryBuild: "context-test",
    hostBuild: "host-test",
    configDigest: sha256V3("config"),
    approvalRecordId: "context-test",
  });
  return value;
}

function seedLiveWork(root: string): void {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected V3 route");
  recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName: "session-start",
    payload: { session_id: "session-a", model: "claude-fable-5", raw: {} },
    adapter: "claude-code",
    instanceId: "owner-a",
  });
  ensureLiveCoordinationHeartbeat(root, "owner-a", "session-a", "claude-code", "claude-fable-5");
  recordLiveTaskChangeV3({
    coordRoot: root,
    owner: "owner-a",
    nativeSessionId: "session-a",
    adapter: "claude-code",
    task: "finish the continuity slice",
  });
  recordLiveClaimChangeV3({
    coordRoot: root,
    owner: "owner-a",
    nativeSessionId: "session-a",
    adapter: "claude-code",
    operation: "acquired",
    path: "src/core/context/index.ts",
    access: "write",
  });
}

afterEach(() => {
  mock.restore();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("context telemetry", () => {
  test("normalizes reported Claude context usage and model identity", () => {
    const sample = extractContextSample(
      {
        model: { id: "claude-fable-5", display_name: "Fable 5" },
        context_window: {
          context_window_size: 1_000_000,
          current_usage: {
            input_tokens: 100_000,
            cache_read_input_tokens: 250_000,
            cache_creation_input_tokens: 50_000,
          },
        },
      },
      { sessionId: "session-a", adapter: "claude-code", observedAt: "2026-07-21T00:00:00Z" },
    );
    expect(sample).toEqual({
      session_id: "session-a",
      adapter: "claude-code",
      model: "claude-fable-5",
      used_tokens: 400_000,
      window_tokens: 1_000_000,
      used_percent: 40,
      source: "hook",
      confidence: "reported",
      observed_at: "2026-07-21T00:00:00Z",
    });
  });

  test("returns null when a hook exposes no context measurement", () => {
    expect(
      extractContextSample(
        { session_id: "session-a", model: "claude-fable-5" },
        { sessionId: "session-a", adapter: "claude-code" },
      ),
    ).toBeNull();
  });

  test("deduplicates identical measurements without rewriting semantic state", () => {
    const coordRoot = root();
    const sample = extractContextSample(
      { context_window: { context_window_size: 200_000, used_percentage: 50 } },
      { sessionId: "session-a", adapter: "claude-code", observedAt: "2026-07-21T00:00:00Z" },
    )!;
    expect(recordContextSample(coordRoot, "owner-a", sample).changed).toBe(true);
    expect(
      recordContextSample(coordRoot, "owner-a", { ...sample, observed_at: "later" }).changed,
    ).toBe(false);
    expect(readContextState(coordRoot, "session-a")?.latest_context?.used_percent).toBe(50);
  });
});

describe("continuity checkpoints", () => {
  test("captures heartbeat state and reuses duplicate PreCompact checkpoints", () => {
    const coordRoot = root();
    seedLiveWork(coordRoot);

    const first = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      adapter: "claude-code",
      cwd: coordRoot,
      reason: "pre_compact",
    });
    const duplicate = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      adapter: "claude-code",
      cwd: coordRoot,
      reason: "pre_compact",
    });

    expect(first.reused).toBe(false);
    expect(duplicate.reused).toBe(true);
    expect(duplicate.capsule.capsule_id).toBe(first.capsule.capsule_id);
    expect(first.capsule.work.task).toBe("finish the continuity slice");
    expect(first.capsule.work.files_held).toEqual(["src/core/context/index.ts"]);
    expect(existsSync(first.path)).toBe(true);
  });

  test("recovery advances phase and a later PreCompact creates a new generation", () => {
    const coordRoot = root();
    const first = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      adapter: "claude-code",
      cwd: coordRoot,
      reason: "pre_compact",
      continuationNote: "run focused tests next",
    });
    const recovery = recoverContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      cwd: coordRoot,
    });
    const second = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      adapter: "claude-code",
      cwd: coordRoot,
      reason: "pre_compact",
    });

    expect(recovery.recovered).toBe(true);
    expect(recovery.state.phase).toBe("recovered");
    expect(recovery.briefing).toContain("run focused tests next");
    expect(second.capsule.generation).toBe(first.capsule.generation + 1);
    expect(second.state.compaction_completed_at).toBeUndefined();
    const completed = markContextCompactionCompleted(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      observedAt: "2026-07-21T01:00:00Z",
    });
    expect(completed.compaction_completed_at).toBe("2026-07-21T01:00:00Z");
  });

  test("a post-compaction signal without a checkpoint is explicit degradation", () => {
    const coordRoot = root();
    const observed = markContextCompactionCompleted(coordRoot, {
      sessionId: "missing",
      instanceId: "owner-a",
    });
    expect(observed.phase).toBe("degraded");
    expect(observed.degraded_reason).toContain("without a continuity checkpoint");

    const result = recoverContext(coordRoot, {
      sessionId: "missing",
      instanceId: "owner-a",
      cwd: coordRoot,
    });
    expect(result.recovered).toBe(false);
    expect(result.state.phase).toBe("degraded");
    expect(result.state.degraded_reason).toContain("without a continuity checkpoint");
  });

  test("recovery briefing calls out repository drift", () => {
    const capsule = {
      schema_version: 1,
      capsule_id: "capsule-a",
      generation: 2,
      created_at: "2026-07-21T00:00:00Z",
      reason: "pre_compact",
      session: {
        session_id: "session-a",
        instance_id: "owner-a",
        adapter: "claude-code",
      },
      work: { task: "ship it", files_held: ["src/a.ts"] },
      repo: {
        cwd: "/repo",
        observation: "ok",
        root: "/repo",
        branch: "next",
        head: "aaaaaaaaaaaaaaaa",
        dirty_paths: ["src/a.ts"],
      },
    } satisfies ContinuityCapsule;
    const briefing = renderRecoveryBriefing(capsule, {
      cwd: "/repo",
      observation: "ok",
      root: "/repo",
      branch: "main",
      head: "bbbbbbbbbbbbbbbb",
      dirty_paths: ["src/b.ts"],
    });
    expect(briefing).toContain("branch changed next -> main");
    expect(briefing).toContain("new dirty paths: src/b.ts");
    expect(briefing).toContain("Re-check before editing");
  });
});

function continuityInbox(coordRoot: string): HarneryInboxService {
  return new HarneryInboxService({
    coord_root: coordRoot,
    limits: {
      max_message_body_bytes: 4_000,
      max_pending_count: 25,
      max_pending_bytes: 100_000,
      max_history_bytes: 1024 * 1024,
      max_history_records: 10_000,
      warning_pressure_ratio: 0.8,
      max_surface_count: 10,
      max_surface_bytes: 16_000,
      max_surface_tokens: 4_000,
      surfaced_grace_ms: 604_800_000,
      terminal_grace_ms: 604_800_000,
    },
  });
}

function coordinationInput(inbox: HarneryInboxService, body: string, recipient = "owner-a") {
  return inbox.send({
    sender_instance_id: "peer-instance",
    sender_display_name: "Peer",
    recipient_instance_id: recipient,
    recipient_display_name: "Recipient",
    body,
  });
}

function compactionCheckpoint(coordRoot: string) {
  return checkpointContext(coordRoot, {
    sessionId: "session-a",
    instanceId: "owner-a",
    adapter: "claude-code",
    cwd: coordRoot,
    reason: "pre_compact",
  });
}

describe("compaction coordination input", () => {
  // A provider session ID alone never transfers the previous task's context.
  test("reused session IDs cannot expose a different instance's capsule", () => {
    mockGitReads();
    const coordRoot = root();
    const checkpoint = checkpointContext(coordRoot, {
      sessionId: "shared-provider-session",
      instanceId: "owner-a",
      adapter: "codex",
      cwd: coordRoot,
      reason: "pre_compact",
      continuationNote: "private task belonging to owner-a",
    });
    const statePath = join(dirname(dirname(checkpoint.path)), "state.json");
    const stateBefore = readFileSync(statePath, "utf8");
    const capsuleBefore = readFileSync(checkpoint.path, "utf8");
    const prepared = prepareContextRecovery(coordRoot, {
      sessionId: "shared-provider-session",
      instanceId: "owner-b",
      cwd: coordRoot,
    });
    expect(prepared).toBeNull();
    expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(readFileSync(checkpoint.path, "utf8")).toBe(capsuleBefore);
    expect(readContextState(coordRoot, "shared-provider-session")?.recovered_at).toBeUndefined();
  });

  // Acceptance applies only to the checkpoint whose briefing was prepared.
  test("completion of a prepared generation cannot complete a newer checkpoint", () => {
    mockGitReads();
    const coordRoot = root();
    const input = { sessionId: "session-a", instanceId: "owner-a" };
    compactionCheckpoint(coordRoot);
    const old = prepareContextRecovery(coordRoot, { ...input, cwd: coordRoot })!;
    const newer = checkpointContext(coordRoot, {
      ...input,
      adapter: "claude-code",
      cwd: coordRoot,
      reason: "manual",
      continuationNote: "new generation",
    });
    expect(newer.capsule.generation).toBe(old.capsule.generation + 1);
    const statePath = join(dirname(dirname(newer.path)), "state.json");
    const newerBytes = readFileSync(statePath, "utf8");
    expect(completeContextRecovery(coordRoot, { ...input, checkpoint: old.checkpoint })).toBeNull();
    expect(readContextState(coordRoot, input.sessionId)?.phase).toBe("checkpointed");
    expect(readFileSync(statePath, "utf8")).toBe(newerBytes);
  });

  test("repeated completion of the same accepted checkpoint is a byte-stable no-op", () => {
    mockGitReads();
    const coordRoot = root();
    const checkpoint = compactionCheckpoint(coordRoot);
    const prepared = prepareContextRecovery(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      cwd: coordRoot,
    })!;
    const input = {
      sessionId: "session-a",
      instanceId: "owner-a",
      checkpoint: prepared.checkpoint,
    };
    const completed = completeContextRecovery(coordRoot, input)!;
    expect(completed.phase).toBe("recovered");
    const statePath = join(dirname(dirname(checkpoint.path)), "state.json");
    const bytes = readFileSync(statePath, "utf8");
    expect(completeContextRecovery(coordRoot, input)).toEqual(completed);
    expect(readFileSync(statePath, "utf8")).toBe(bytes);
    expect(readLatestCapsule(coordRoot, "session-a")?.capsule_id).toBe(
      checkpoint.capsule.capsule_id,
    );
  });

  test("changed prepared authority never accepts the latest checkpoint", () => {
    mockGitReads();
    const coordRoot = root();
    const checkpoint = compactionCheckpoint(coordRoot);
    const prepared = prepareContextRecovery(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      cwd: coordRoot,
    })!;
    const statePath = join(dirname(dirname(checkpoint.path)), "state.json");
    const bytes = readFileSync(statePath, "utf8");
    const input = { sessionId: "session-a", instanceId: "owner-a" };
    for (const changed of [
      { session_id: "other-session" },
      { instance_id: "owner-b" },
      { generation: prepared.checkpoint.generation + 1 },
      { capsule_id: "different-capsule" },
    ]) {
      expect(
        completeContextRecovery(coordRoot, {
          ...input,
          checkpoint: { ...prepared.checkpoint, ...changed },
        }),
      ).toBeNull();
      expect(readFileSync(statePath, "utf8")).toBe(bytes);
    }
  });

  test("pre-compaction reuse cannot return a foreign instance capsule", () => {
    mockGitReads();
    const coordRoot = root();
    const first = compactionCheckpoint(coordRoot);
    const firstBytes = readFileSync(first.path, "utf8");
    const second = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-b",
      adapter: "codex",
      cwd: coordRoot,
      reason: "pre_compact",
      continuationNote: "owner-b task",
    });
    expect(second.reused).toBe(false);
    expect(second.capsule.session.instance_id).toBe("owner-b");
    expect(second.capsule.generation).toBe(first.capsule.generation + 1);
    expect(second.capsule.work.continuation_note).toBe("owner-b task");
    expect(readFileSync(first.path, "utf8")).toBe(firstBytes);
  });

  test("a foreign compaction observation does not change the current owner", () => {
    mockGitReads();
    const coordRoot = root();
    const first = compactionCheckpoint(coordRoot);
    const statePath = join(dirname(dirname(first.path)), "state.json");
    const bytes = readFileSync(statePath, "utf8");
    markContextCompactionCompleted(coordRoot, { sessionId: "session-a", instanceId: "owner-b" });
    expect(readFileSync(statePath, "utf8")).toBe(bytes);
  });

  // Completion compares the state it read with the state on disk before replacing it.
  test("convenience recovery refuses if a newer checkpoint lands during completion", () => {
    mockGitReads();
    const coordRoot = root();
    const checkpoint = compactionCheckpoint(coordRoot);
    const write = fs.writeFileSync;
    let advanced = false;
    spyOn(fs, "writeFileSync").mockImplementation(((path, data, options) => {
      write(path, data, options);
      if (!advanced && String(data).includes('"phase": "recovered"')) {
        advanced = true;
        checkpointContext(coordRoot, {
          sessionId: "session-a",
          instanceId: "owner-a",
          adapter: "claude-code",
          cwd: coordRoot,
          reason: "manual",
          continuationNote: "new checkpoint during completion",
        });
      }
    }) as typeof fs.writeFileSync);
    const result = recoverContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      cwd: coordRoot,
    });
    expect(advanced).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.capsule).toBeNull();
    expect(result.briefing).toBe("");
    const state = readContextState(coordRoot, "session-a");
    expect(state?.phase).toBe("checkpointed");
    expect(state?.generation).toBe(checkpoint.capsule.generation + 1);
    const sessionDir = dirname(dirname(checkpoint.path));
    expect(fs.readdirSync(sessionDir).filter((name) => name.includes(".tmp."))).toEqual([]);
  });

  test("context samples write no lease", () => {
    const coordRoot = root();
    const sample = extractContextSample(
      { context_window: { context_window_size: 1_000, used_tokens: 10 } },
      { sessionId: "session-a", adapter: "claude-code" },
    )!;
    recordContextSample(coordRoot, "owner-a", sample);
    recordContextSample(coordRoot, "owner-a", { ...sample, used_tokens: 20 });
    const contextRoot = join(coordRoot, ".harnery", "context");
    const [sessionKey] = fs.readdirSync(contextRoot);
    expect(fs.readdirSync(join(contextRoot, sessionKey!))).toEqual(["state.json"]);
  });

  test("recovery lists input surfaced immediately before compaction without changing history", async () => {
    mockGitReads();
    const coordRoot = root();
    seedLiveWork(coordRoot);
    const inbox = continuityInbox(coordRoot);
    const sent = coordinationInput(inbox, "check the pending review before editing");
    await inbox.surface("owner-a", () => {});
    const checkpoint = compactionCheckpoint(coordRoot);
    const capsuleBefore = readFileSync(checkpoint.path, "utf8");
    const inboxBefore = readFileSync(inboxPath(coordRoot, "owner-a"), "utf8");
    const ledgerPath = join(coordRoot, ".harnery", "ledgers", "v3", "active.ndjson");
    const ledgerBefore = readFileSync(ledgerPath, "utf8");

    const prepared = prepareContextRecovery(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      cwd: coordRoot,
    });

    expect(prepared?.briefing).toContain(sent.message_id);
    expect(prepared?.briefing).toContain("check the pending review before editing");
    expect(prepared?.briefing).toContain("`harn agents inbox list owner-a`");
    expect(inbox.pending("owner-a")).toEqual([]);
    expect(readFileSync(checkpoint.path, "utf8")).toBe(capsuleBefore);
    expect(readFileSync(inboxPath(coordRoot, "owner-a"), "utf8")).toBe(inboxBefore);
    expect(readFileSync(ledgerPath, "utf8")).toBe(ledgerBefore);
  });

  for (const outcome of ["failed", "cancelled"] as const) {
    test(`${outcome} recovery injection never records successful recovery`, async () => {
      mockGitReads();
      const coordRoot = root();
      const inbox = continuityInbox(coordRoot);
      coordinationInput(inbox, `preserve input after ${outcome} compaction`);
      const checkpoint = compactionCheckpoint(coordRoot);
      const prepared = prepareContextRecovery(coordRoot, {
        sessionId: "session-a",
        instanceId: "owner-a",
        cwd: coordRoot,
      });
      expect(prepared).not.toBeNull();
      // This covers abandoned preparation, not vendor-specific outcome signals.
      const error = new Error(`${outcome} native context acceptance`);
      if (outcome === "cancelled") error.name = "AbortError";
      await expect(Promise.reject(error)).rejects.toThrow(error.message);

      const state = readContextState(coordRoot, "session-a")!;
      expect(state.phase).toBe("checkpointed");
      expect(state.recovered_at).toBeUndefined();
      expect(state.compaction_completed_at).toBeUndefined();
      expect(inbox.pending("owner-a")).toHaveLength(1);
      const retry = compactionCheckpoint(coordRoot);
      expect(retry.reused).toBe(true);
      expect(retry.capsule.capsule_id).toBe(checkpoint.capsule.capsule_id);
    });
  }

  test("two overflows retain steering input and retries stay in one generation", async () => {
    mockGitReads();
    const coordRoot = root();
    const inbox = continuityInbox(coordRoot);
    const first = coordinationInput(inbox, "first feedback before the tool batch");
    let laterId = "";
    await inbox.surface("owner-a", () => {
      laterId = coordinationInput(inbox, "steering queued during the tool batch").message_id;
    });
    coordinationInput(inbox, "private input for a different instance", "other-instance");
    const history = readFileSync(inboxPath(coordRoot, "owner-a"), "utf8");
    let generation = 0;

    for (let overflow = 0; overflow < 2; overflow++) {
      const checkpoint = compactionCheckpoint(coordRoot);
      expect(checkpoint.capsule.generation).toBe(++generation);
      for (let retry = 0; retry < 2; retry++) {
        expect(compactionCheckpoint(coordRoot).reused).toBe(true);
        const prepared = prepareContextRecovery(coordRoot, {
          sessionId: "session-a",
          instanceId: "owner-a",
          cwd: coordRoot,
        })!;
        expect(prepared.briefing.split(first.message_id)).toHaveLength(2);
        expect(prepared.briefing.split(laterId)).toHaveLength(2);
        expect(prepared.briefing).toContain("steering queued during the tool batch");
        expect(prepared.briefing).not.toContain("private input for a different instance");
        expect(inbox.pending("owner-a").map(({ message_id }) => message_id)).toEqual([laterId]);
        expect(readFileSync(inboxPath(coordRoot, "owner-a"), "utf8")).toBe(history);
      }
      const accepted = prepareContextRecovery(coordRoot, {
        sessionId: "session-a",
        instanceId: "owner-a",
        cwd: coordRoot,
      })!;
      completeContextRecovery(coordRoot, {
        sessionId: "session-a",
        instanceId: "owner-a",
        checkpoint: accepted.checkpoint,
      });
    }
    expect(readContextState(coordRoot, "session-a")?.generation).toBe(2);
  });

  test("recovery bounds excerpts while listing the full pending capacity and latest surfaced batch", async () => {
    mockGitReads();
    const coordRoot = root();
    const inbox = continuityInbox(coordRoot);
    const recent = Array.from(
      { length: 10 },
      (_, index) => coordinationInput(inbox, `recent feedback ${index}`).message_id,
    );
    await inbox.surface("owner-a", () => {});
    const pending = Array.from(
      { length: 25 },
      () => coordinationInput(inbox, "🧭".repeat(1_000)).message_id,
    );
    compactionCheckpoint(coordRoot);
    const briefing = prepareContextRecovery(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      cwd: coordRoot,
    })!.briefing;
    expect(briefing).toContain("Coordination input after compaction");
    const input = briefing.slice(briefing.indexOf("Coordination input after compaction"));
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(12 * 1024);
    expect(input).toContain("[excerpt]");
    expect(input).not.toContain("�");
    for (const id of [...recent, ...pending]) expect(input.split(id)).toHaveLength(2);
    expect(inbox.pending("owner-a").map(({ message_id }) => message_id)).toEqual(pending);
  });

  test("unreadable inbox history is explicit and recovery never rewrites it", () => {
    mockGitReads();
    const coordRoot = root();
    const inbox = continuityInbox(coordRoot);
    coordinationInput(inbox, "do not erase unreadable input");
    const path = inboxPath(coordRoot, "owner-a");
    writeFileSync(path, "invalid-json\n");
    compactionCheckpoint(coordRoot);
    const prepared = prepareContextRecovery(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      cwd: coordRoot,
    });
    expect(prepared?.briefing).toContain("Coordination input could not be read");
    expect(prepared?.briefing).toContain("`harn agents inbox list owner-a`");
    expect(readFileSync(path, "utf8")).toBe("invalid-json\n");
    expect(readContextState(coordRoot, "session-a")?.phase).toBe("checkpointed");
  });

  test("invalid inbox schema, receipt order, duplicate IDs and oversized IDs stay unreadable", () => {
    mockGitReads();
    const coordRoot = root();
    const inbox = continuityInbox(coordRoot);
    coordinationInput(inbox, "keep invalid input out of the briefing");
    const message = inbox.records("owner-a")[0]!;
    const receipt = {
      schema: "harnery.inbox-record/v1",
      kind: "surfaced",
      message_id: message.message_id,
      surfaced_at: "2026-10-17T00:00:00Z",
    };
    const path = inboxPath(coordRoot, "owner-a");
    compactionCheckpoint(coordRoot);
    for (const records of [
      [{ ...message, schema: "unknown" }],
      [receipt, message],
      [message, message],
      [{ ...message, message_id: "x".repeat(7_000) }],
    ]) {
      const content = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
      writeFileSync(path, content);
      const prepared = prepareContextRecovery(coordRoot, {
        sessionId: "session-a",
        instanceId: "owner-a",
        cwd: coordRoot,
      });
      expect(prepared?.briefing).toContain("Coordination input could not be read");
      expect(Buffer.byteLength(prepared!.briefing)).toBeLessThan(12 * 1024);
      expect(readFileSync(path, "utf8")).toBe(content);
    }
  });
});

const observedRepo: RepoSnapshot = {
  cwd: "/repo",
  observation: "ok",
  root: "/repo",
  branch: "main",
  head: "a".repeat(40),
  dirty_paths: [],
};

function capsuleFor(repo: RepoSnapshot): ContinuityCapsule {
  return {
    schema_version: 1,
    capsule_id: "snapshot-test",
    generation: 1,
    created_at: "2026-10-16T00:00:00Z",
    reason: "manual",
    session: { session_id: "session-a", instance_id: "owner-a", adapter: "claude-code" },
    work: { files_held: [] },
    repo,
  };
}

function gitResult(out: string, status = 0, error?: NodeJS.ErrnoException) {
  return {
    pid: 1,
    output: [null, out, ""],
    stdout: out,
    stderr: status === 0 ? "" : "fatal: test read failed",
    status,
    signal: null,
    error,
  } as unknown as ReturnType<typeof childProcess.spawnSync>;
}

function mockGitReads(overrides: Record<string, ReturnType<typeof gitResult>> = {}) {
  const defaults = {
    "rev-parse --show-toplevel": gitResult("/repo\n"),
    "status --porcelain=v1 --untracked-files=normal": gitResult(""),
    "rev-parse --abbrev-ref HEAD": gitResult("main\n"),
    "rev-parse HEAD": gitResult(`${"a".repeat(40)}\n`),
  };
  return spyOn(childProcess, "spawnSync").mockImplementation(((
    _command: string,
    args?: readonly string[] | childProcess.SpawnSyncOptions,
  ) => {
    const key = Array.isArray(args) ? args.join(" ") : "";
    return overrides[key] ?? defaults[key as keyof typeof defaults] ?? gitResult("", 1);
  }) as typeof childProcess.spawnSync);
}

function expectUnverified(briefing: string) {
  expect(briefing).toContain("could not be verified against the checkpoint");
  expect(briefing).toContain("Re-check before editing");
  expect(briefing).not.toContain("matches");
  expect(briefing).not.toContain("paths no longer dirty");
}

describe("repository observation safety", () => {
  test("the missing repository probe never establishes a match or cleared path", () => {
    const live = snapshotRepo("/dev/null/not-a-repository");
    expect(live.observation).toBe("unavailable");
    expect(live.observation_detail).toContain("top-level:");
    expectUnverified(renderRecoveryBriefing(capsuleFor(observedRepo), live));
    expectUnverified(
      renderRecoveryBriefing(
        capsuleFor({
          ...observedRepo,
          dirty_paths: ["src/a.ts"],
        }),
        live,
      ),
    );
  });

  test("failed status reads preserve an explicit failure instead of clearing dirty paths", () => {
    mockGitReads({ "status --porcelain=v1 --untracked-files=normal": gitResult("", 1) });
    const live = snapshotRepo("/repo");
    expect(live.observation).toBe("partial");
    expect(live.observation_detail).toBe("status: failed");
    expectUnverified(
      renderRecoveryBriefing(
        capsuleFor({
          ...observedRepo,
          dirty_paths: ["src/a.ts"],
        }),
        live,
      ),
    );
  });

  test("an injected timeout makes the entire observation unavailable", () => {
    const error = Object.assign(new Error("read timed out"), { code: "ETIMEDOUT" });
    mockGitReads({ "status --porcelain=v1 --untracked-files=normal": gitResult("", 1, error) });
    const live = snapshotRepo("/repo");
    expect(live.observation).toBe("unavailable");
    expect(live.observation_detail).toBe("status: timed_out");
    expectUnverified(renderRecoveryBriefing(capsuleFor(observedRepo), live));
  });

  test("a successful empty status still establishes a match", () => {
    mockGitReads();
    const live = snapshotRepo("/repo");
    expect(live.observation).toBe("ok");
    expect(live.dirty_paths).toEqual([]);
    expect(renderRecoveryBriefing(capsuleFor(observedRepo), live)).toContain(
      "Repository state matches the checkpoint.",
    );
  });

  test("leading status spaces do not consume the first file name", () => {
    mockGitReads({ "status --porcelain=v1 --untracked-files=normal": gitResult(" M README.md\n") });
    expect(snapshotRepo("/repo").dirty_paths).toEqual(["README.md"]);
  });

  test("truncated lists cannot claim a path was cleared when it moved beyond the prefix", () => {
    const paths = Array.from(
      { length: 16 },
      (_, index) => `src/${String(index).padStart(2, "0")}.ts`,
    );
    mockGitReads({
      "status --porcelain=v1 --untracked-files=normal": gitResult(
        paths.map((path) => ` M ${path}`).join("\n"),
      ),
    });
    const live = snapshotRepo("/repo");
    expect(live.observation).toBe("partial");
    expect(live.dirty_paths_truncated).toBe(true);
    expect(live.dirty_paths).toHaveLength(15);
    expectUnverified(
      renderRecoveryBriefing(
        capsuleFor({
          ...observedRepo,
          dirty_paths: [paths[15]!],
        }),
        live,
      ),
    );
    expectUnverified(
      renderRecoveryBriefing(
        capsuleFor({
          ...observedRepo,
          dirty_paths_truncated: true,
        }),
        observedRepo,
      ),
    );
  });

  test("failed branch and HEAD reads are reported as unknown", () => {
    for (const field of ["branch", "head"] as const) {
      for (const value of [undefined, "", " "]) {
        const live = { ...observedRepo, [field]: value };
        const briefing = renderRecoveryBriefing(capsuleFor(observedRepo), live);
        expectUnverified(briefing);
        expect(briefing).toContain(`${field === "head" ? "HEAD" : "branch"} is unknown`);
      }
    }
    mockGitReads({
      "rev-parse --abbrev-ref HEAD": gitResult("", 1),
      "rev-parse HEAD": gitResult("", 1),
    });
    const live = snapshotRepo("/repo");
    expect(live.observation).toBe("partial");
    expect(live.observation_detail).toBe("branch: failed; HEAD: failed");
    expectUnverified(renderRecoveryBriefing(capsuleFor(observedRepo), live));
  });

  test("missing, malformed, or different repository roots cannot establish a match", () => {
    for (const root of [undefined, "relative-root", "/different-repository"]) {
      const briefing = renderRecoveryBriefing(capsuleFor({ ...observedRepo, root }), observedRepo);
      expectUnverified(briefing);
      expect(briefing).toContain("repository root");
    }
  });

  test("snapshots without an observation never establish a match", () => {
    const { observation: _observation, ...legacy } = observedRepo;
    expect(repoComparisonProblems(legacy as RepoSnapshot, observedRepo, ["old", "new"])).toEqual([
      "old snapshot is unavailable",
    ]);
    expectUnverified(renderRecoveryBriefing(capsuleFor(legacy as RepoSnapshot), observedRepo));
  });
});
