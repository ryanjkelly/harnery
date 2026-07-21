import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ContinuityCapsule,
  checkpointContext,
  extractContextSample,
  markContextCompactionCompleted,
  readContextState,
  recordContextSample,
  recoverContext,
  renderRecoveryBriefing,
} from "./index.ts";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "harnery-context-"));
  roots.push(value);
  mkdirSync(join(value, ".harnery", "active"), { recursive: true });
  return value;
}

afterEach(() => {
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
      { sessionId: "session-a", harness: "claude-code", observedAt: "2026-07-21T00:00:00Z" },
    );
    expect(sample).toEqual({
      session_id: "session-a",
      harness: "claude-code",
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
        { sessionId: "session-a", harness: "claude-code" },
      ),
    ).toBeNull();
  });

  test("deduplicates identical measurements without rewriting semantic state", () => {
    const coordRoot = root();
    const sample = extractContextSample(
      { context_window: { context_window_size: 200_000, used_percentage: 50 } },
      { sessionId: "session-a", harness: "claude-code", observedAt: "2026-07-21T00:00:00Z" },
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
    writeFileSync(
      join(coordRoot, ".harnery", "active", "owner-a.json"),
      JSON.stringify({
        instance_id: "owner-a",
        model: "claude-fable-5",
        task: "finish the continuity slice",
        turn_summary: "core store is implemented",
        files_touched: ["src/core/context/index.ts"],
        last_tool: "Edit",
        last_tool_target: "src/core/context/index.ts",
      }),
    );

    const first = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      harness: "claude-code",
      cwd: coordRoot,
      reason: "pre_compact",
    });
    const duplicate = checkpointContext(coordRoot, {
      sessionId: "session-a",
      instanceId: "owner-a",
      harness: "claude-code",
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
      harness: "claude-code",
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
      harness: "claude-code",
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
        harness: "claude-code",
      },
      work: { task: "ship it", files_held: ["src/a.ts"] },
      repo: {
        cwd: "/repo",
        branch: "next",
        head: "aaaaaaaaaaaaaaaa",
        dirty_paths: ["src/a.ts"],
      },
    } satisfies ContinuityCapsule;
    const briefing = renderRecoveryBriefing(capsule, {
      cwd: "/repo",
      branch: "main",
      head: "bbbbbbbbbbbbbbbb",
      dirty_paths: ["src/b.ts"],
    });
    expect(briefing).toContain("branch changed next -> main");
    expect(briefing).toContain("new dirty paths: src/b.ts");
    expect(briefing).toContain("Re-check before editing");
  });
});
