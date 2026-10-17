import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordLiveClaimChangeV3, recordLiveTaskChangeV3 } from "../agents/live-authority-v3.ts";
import { ensureLiveCoordinationHeartbeat } from "../agents/state/live-coordination-writer.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { sha256V3 } from "../events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../events/v3/live-routing.ts";
import {
  type ContinuityCapsule,
  checkpointContext,
  extractContextSample,
  markContextCompactionCompleted,
  observationsComparable,
  type RepoSnapshot,
  readContextState,
  readLatestCapsule,
  recordContextSample,
  recoverContext,
  renderRecoveryBriefing,
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

  test("legacy snapshots are unavailable and observation details stay bounded", () => {
    const coordRoot = root();
    const checkpoint = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      adapter: "claude-code",
      cwd: coordRoot,
      reason: "manual",
    });
    const persisted = JSON.parse(readFileSync(checkpoint.path, "utf8"));
    delete persisted.repo.observation;
    persisted.repo.observation_detail = "x".repeat(1_000);
    writeFileSync(checkpoint.path, JSON.stringify(persisted));
    const loaded = readLatestCapsule(coordRoot, "session-a")!;
    expect(loaded.repo.observation).toBe("unavailable");
    expect(loaded.repo.observation_detail).toHaveLength(500);
    expect(observationsComparable({}, observedRepo)).toBe(false);
    expectUnverified(renderRecoveryBriefing(loaded, observedRepo));
  });

  test("malformed capsule shapes degrade recovery without throwing", () => {
    const coordRoot = root();
    const checkpoint = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      adapter: "claude-code",
      cwd: coordRoot,
      reason: "manual",
    });
    for (const repo of [null, [], {}, { cwd: "/repo", dirty_paths: "not a list" }]) {
      writeFileSync(checkpoint.path, JSON.stringify({ ...checkpoint.capsule, repo }));
      expect(readLatestCapsule(coordRoot, "session-a")).toBeNull();
      expect(
        recoverContext(coordRoot, { sessionId: "session-a", instanceId: "owner-a", cwd: coordRoot })
          .state.phase,
      ).toBe("degraded");
    }
  });
});
