import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSupervisorActivitySnapshot } from "./activity.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervisor activity projection", () => {
  test("reads current generation-bound cache rows", () => {
    const root = activityRoot();
    writeCache(root, "agent-a", {
      activity: "working",
      task_state: "active",
      last_heartbeat: "2026-08-30T12:00:00.000Z",
    });
    const snapshot = collectSupervisorActivitySnapshot(
      root,
      new Date("2026-08-30T12:01:00.000Z"),
    );
    expect(snapshot.capability.state).toBe("supported");
    expect(snapshot.entries).toMatchObject([
      {
        scope_id: "agent-a",
        declared_activity: "working",
        task_state: "active",
        source: { source_kind: "coordination.activity-projection", capability: "supported" },
      },
    ]);
  });

  test("omits stale, malformed, and symlink cache rows with an explicit partial capability", () => {
    const root = activityRoot();
    writeCache(root, "stale-agent", {
      activity: "idle",
      task_state: "active",
      last_heartbeat: "2026-08-30T11:00:00.000Z",
    });
    writeFileSync(join(root, ".harnery", "active", "malformed.json"), "{", "utf8");
    const target = join(root, "outside.json");
    writeFileSync(target, JSON.stringify(cache("linked-agent", {})), "utf8");
    symlinkSync(target, join(root, ".harnery", "active", "linked-agent.json"));
    const snapshot = collectSupervisorActivitySnapshot(
      root,
      new Date("2026-08-30T12:01:00.000Z"),
    );
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.omitted_entry_count).toBe(3);
    expect(snapshot.capability).toMatchObject({
      state: "partial",
      reason_code: "bounded-cache-rejection",
    });
  });
});

function activityRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-activity-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery", "active"), { recursive: true });
  return root;
}

function writeCache(
  root: string,
  id: string,
  overrides: Partial<ReturnType<typeof cache>>,
): void {
  writeFileSync(
    join(root, ".harnery", "active", `${id}.json`),
    JSON.stringify(cache(id, overrides)),
    "utf8",
  );
}

function cache(id: string, overrides: Record<string, unknown>) {
  return {
    schema_version: 2,
    instance_id: id,
    session_id: `session-${id}`,
    activity: "working",
    task_state: "active",
    last_heartbeat: "2026-08-30T12:00:00.000Z",
    v3_instance_id: `inst_${id}`,
    v3_generation_id: "gen_test",
    ...overrides,
  };
}
