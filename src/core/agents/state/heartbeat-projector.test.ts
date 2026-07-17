/**
 * Locks the readExisting coercion that keeps the projector robust to heartbeats
 * written by the NON-projector producers (heartbeat-writer.ts: healHeartbeat,
 * setTask, stampToolActivity, …). Those write a v1-shaped body with no
 * `v2_meta` / `events_applied`; readExisting used to `as`-cast it straight to
 * V2Heartbeat, so apply() threw on `hb.v2_meta.last_projected` (200+×/day,
 * caught+logged) and silently NaN'd `hb.events_applied += 1`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectHeartbeats } from "./heartbeat-projector.ts";
import { assignName } from "./names.ts";

type Events = Parameters<typeof projectHeartbeats>[1];

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-proj-"));
  mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
  return root;
}

function writeRawHeartbeat(root: string, instanceId: string, body: Record<string, unknown>): void {
  writeFileSync(
    path.join(root, ".harnery", "active", `${instanceId}.json`),
    JSON.stringify(body),
    "utf8",
  );
}

describe("projectHeartbeats: coercion of writer-produced heartbeats", () => {
  test("projects onto a healHeartbeat-shaped body (no v2_meta / events_applied) without crashing or NaN", () => {
    const root = freshRoot();
    // Mirror exactly what heartbeat-writer.healHeartbeat persists: a v1 body
    // with NO v2_meta and NO events_applied, the crash source.
    writeRawHeartbeat(root, "healed-x", {
      schema_version: 1,
      instance_id: "healed-x",
      session_id: "healed-x",
      name: "Healed",
      kind: "session",
      model: "",
      started_at: "2026-06-04T00:00:00Z",
      last_heartbeat: "2026-06-04T00:00:00Z",
      files_touched: [],
      platform: "cursor",
    });
    const events = [
      {
        event_id: "01EVENT",
        event_type: "tool.pre_use",
        ts: "2026-06-04T00:01:00Z",
        instance_id: "healed-x",
        session_id: "healed-x",
        harness: "cursor",
        source: "test",
        data: {},
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events); // must not throw
    expect(res.written).toContain("healed-x");

    const hb = res.perOwner["healed-x"]!;
    expect(hb.v2_meta).toBeDefined();
    expect(hb.v2_meta.schema_version).toBe(1);
    expect(typeof hb.events_applied).toBe("number");
    expect(Number.isNaN(hb.events_applied)).toBe(false);
    expect(hb.events_applied).toBe(1); // coerced 0 + 1

    // `events_applied` IS in writeHeartbeat's persisted allowlist, so the NaN
    // fix self-heals on disk (1, not null/NaN). `v2_meta` is deliberately NOT
    // persisted (ephemeral per-drain bookkeeping); readExisting re-coerces it
    // every read, so we don't assert it on disk.
    const onDisk = JSON.parse(
      readFileSync(path.join(root, ".harnery", "active", "healed-x.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk.events_applied).toBe(1);
  });

  test("a freshly-seeded heartbeat is unaffected (events_applied increments from 0)", () => {
    const root = freshRoot();
    const events = [
      {
        event_id: "01A",
        event_type: "session.start",
        ts: "2026-06-04T00:00:00Z",
        instance_id: "fresh-y",
        session_id: "fresh-y",
        harness: "claude-code",
        source: "test",
        data: {},
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events);
    expect(res.perOwner["fresh-y"]!.events_applied).toBe(1);
    expect(res.perOwner["fresh-y"]!.v2_meta).toBeDefined();
  });

  test("session.start with workflow_run_id stamps the heartbeat (workflow-child linkage)", () => {
    const root = freshRoot();
    const events = [
      {
        event_id: "01WF",
        event_type: "session.start",
        ts: "2026-06-04T00:00:00Z",
        instance_id: "wf-child-1",
        session_id: "wf-child-1",
        harness: "claude-code",
        source: "test",
        data: { workflow_run_id: "wf-2026-06-04T00-00-00-000Z-abc123" },
      },
    ] as unknown as Events;

    projectHeartbeats(root, events);
    const onDisk = JSON.parse(
      readFileSync(path.join(root, ".harnery", "active", "wf-child-1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk.workflow_run_id).toBe("wf-2026-06-04T00-00-00-000Z-abc123");
  });
});

describe("projectHeartbeats: does not resurrect dead agents from terminal events", () => {
  test("a lone subagent.stop for an unseen owner does NOT create a heartbeat (the agent-unknown ghost)", () => {
    const root = freshRoot();
    const events = [
      {
        event_id: "01STOP",
        event_type: "subagent.stop",
        ts: "2026-06-04T00:00:00Z",
        instance_id: "ghost-sub",
        session_id: "parent-uuid",
        harness: "claude-code",
        source: "test",
        data: { exit_status: "ok" },
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events);
    expect(res.written).toEqual([]);
    expect(res.perOwner["ghost-sub"]).toBeUndefined();
    expect(existsSync(path.join(root, ".harnery", "active", "ghost-sub.json"))).toBe(false);
  });

  test("a lone session.end for an unseen owner does NOT create a heartbeat", () => {
    const root = freshRoot();
    const events = [
      {
        event_id: "01END",
        event_type: "session.end",
        ts: "2026-06-04T00:00:00Z",
        instance_id: "ghost-sess",
        session_id: "ghost-sess",
        harness: "claude-code",
        source: "test",
        data: { clean_exit: true },
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events);
    expect(res.perOwner["ghost-sess"]).toBeUndefined();
  });

  test("session.end on an EXISTING heartbeat still applies (tombstones, does not skip)", () => {
    const root = freshRoot();
    writeRawHeartbeat(root, "live-z", {
      schema_version: 1,
      instance_id: "live-z",
      session_id: "live-z",
      name: "Zane",
      started_at: "2026-06-04T00:00:00Z",
      last_heartbeat: "2026-06-04T00:00:00Z",
    });
    const events = [
      {
        event_id: "01E2",
        event_type: "session.end",
        ts: "2026-06-04T01:00:00Z",
        instance_id: "live-z",
        session_id: "live-z",
        harness: "claude-code",
        source: "test",
        data: { clean_exit: true },
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events);
    expect(res.perOwner["live-z"]).toBeDefined();
    expect(res.perOwner["live-z"]!.ended_at).toBeDefined();
  });

  test("a lone health.heartbeat_swept for an unseen owner does NOT resurrect it (the sweep→resurrect loop)", () => {
    // stale-sweep deletes a dead heartbeat then emits health.heartbeat_swept.
    // If the projector replays that event for an owner with no live file, it
    // used to re-seed the very file the sweep just removed, minus
    // files_touched (no start event ran), which readers flag as invalid, and
    // which the next sweep deletes-and-resurrects again. The swept event is
    // terminal: it must never create a heartbeat.
    const root = freshRoot();
    const events = [
      {
        event_id: "01SWEPT",
        event_type: "health.heartbeat_swept",
        ts: "2026-06-10T01:18:07Z",
        instance_id: "swept-ghost",
        session_id: "swept-ghost",
        harness: "claude-code",
        source: "agent-coord",
        data: { reason: "stale", age_secs: 700 },
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events);
    expect(res.written).toEqual([]);
    expect(res.perOwner["swept-ghost"]).toBeUndefined();
    expect(existsSync(path.join(root, ".harnery", "active", "swept-ghost.json"))).toBe(false);
  });

  test("replaying a COMPLETED subagent run end-to-end does NOT re-create the deleted heartbeat (cursor-lag zombie)", () => {
    // The mid-batch variant the seed-time TERMINAL guard can't catch: a drain
    // whose shared cursor lags another consumer replays a finished subagent's
    // WHOLE run: start, tools, stop. The start event seeds (it's not
    // terminal), apply() walks through to the stop, and the write loop used to
    // re-create the heartbeat the sub-agent-stop hook had already unlinked.
    // The zombie then read as a live agent for a full staleness window.
    const root = freshRoot();
    const base = {
      instance_id: "replayed-sub",
      session_id: "parent-uuid",
      harness: "claude-code",
      source: "test",
    };
    const events = [
      {
        ...base,
        event_id: "01RS1",
        event_type: "subagent.start",
        ts: "2026-06-10T03:45:24Z",
        data: { name: "Paxton", kind: "subagent", agent_type: "Explore" },
      },
      {
        ...base,
        event_id: "01RS2",
        event_type: "tool.pre_use",
        ts: "2026-06-10T03:46:00Z",
        data: { tool_name: "Bash" },
      },
      {
        ...base,
        event_id: "01RS3",
        event_type: "subagent.stop",
        ts: "2026-06-10T03:47:37Z",
        data: { exit_status: "ok" },
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events);
    expect(res.written).toEqual([]);
    expect(existsSync(path.join(root, ".harnery", "active", "replayed-sub.json"))).toBe(false);
    // The in-memory projection still happened (callers may inspect perOwner);
    // only the file write is suppressed.
    expect(res.perOwner["replayed-sub"]!.ended_at).toBeDefined();
  });

  test("replaying an IN-FLIGHT run (no terminal event yet) still creates the heartbeat", () => {
    // Locks the guard's scope: a replay of a run that hasn't ended must keep
    // producing a heartbeat; only batches that SAW the owner end are skipped.
    const root = freshRoot();
    const base = {
      instance_id: "inflight-sub",
      session_id: "parent-uuid",
      harness: "claude-code",
      source: "test",
    };
    const events = [
      {
        ...base,
        event_id: "01IF1",
        event_type: "subagent.start",
        ts: "2026-06-10T03:45:24Z",
        data: { name: "Rosa", kind: "subagent", agent_type: "Explore" },
      },
      {
        ...base,
        event_id: "01IF2",
        event_type: "tool.pre_use",
        ts: "2026-06-10T03:46:00Z",
        data: { tool_name: "Bash" },
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events);
    expect(res.written).toContain("inflight-sub");
    expect(existsSync(path.join(root, ".harnery", "active", "inflight-sub.json"))).toBe(true);
  });

  test("a replayed COMPLETED main session does NOT re-create its deleted heartbeat either", () => {
    const root = freshRoot();
    const base = {
      instance_id: "replayed-sess",
      session_id: "replayed-sess",
      harness: "claude-code",
      source: "test",
    };
    const events = [
      {
        ...base,
        event_id: "01MS1",
        event_type: "session.start",
        ts: "2026-06-10T03:00:00Z",
        data: { name: "Owen", kind: "session", platform: "claude_code" },
      },
      {
        ...base,
        event_id: "01MS2",
        event_type: "session.end",
        ts: "2026-06-10T04:00:00Z",
        data: { clean_exit: true },
      },
    ] as unknown as Events;

    const res = projectHeartbeats(root, events);
    expect(res.written).toEqual([]);
    expect(existsSync(path.join(root, ".harnery", "active", "replayed-sess.json"))).toBe(false);
  });

  test("a freshly-seeded heartbeat always writes files_touched as an array", () => {
    // Belt-and-suspenders to the TERMINAL guard: even a non-terminal seed path
    // that never sets files_touched must persist [] so the writer can't emit a
    // file that fails the reader's required-array shape check.
    const root = freshRoot();
    assignName(root, "seed-arr", "session"); // populates .name-history
    const events = [
      {
        event_id: "01STATUS",
        event_type: "state.status_checked",
        ts: "2026-06-10T01:00:00Z",
        instance_id: "seed-arr",
        session_id: "seed-arr",
        harness: "claude-code",
        source: "test",
        data: {},
      },
    ] as unknown as Events;

    projectHeartbeats(root, events);
    const raw = JSON.parse(
      readFileSync(path.join(root, ".harnery", "active", "seed-arr.json"), "utf8"),
    );
    expect(Array.isArray(raw.files_touched)).toBe(true);
  });
});

describe("projectHeartbeats: seeds identity from .name-history (no agent-unknown ghost)", () => {
  function toolEvent(instanceId: string, sessionId: string): unknown {
    return {
      event_id: "01SEED",
      event_type: "tool.pre_use",
      ts: "2026-06-04T00:00:01Z",
      instance_id: instanceId,
      session_id: sessionId,
      harness: "claude-code",
      source: "test",
      data: { tool_name: "Bash", tool_input: JSON.stringify({ command: "git status" }) },
    };
  }

  test("a non-start seed recovers name + kind for a known session owner", () => {
    const root = freshRoot();
    const name = assignName(root, "sess-known", "session"); // populates .name-history
    const res = projectHeartbeats(root, [
      toolEvent("sess-known", "sess-known"),
    ] as unknown as Events);
    const hb = res.perOwner["sess-known"]!;
    expect(hb.name).toBe(name);
    expect(hb.kind).toBe("session");
  });

  test("a non-start subagent seed recovers name + kind + stamps agent_id", () => {
    const root = freshRoot();
    const name = assignName(root, "sub-known", "subagent");
    const res = projectHeartbeats(root, [
      toolEvent("sub-known", "parent-sess"),
    ] as unknown as Events);
    const hb = res.perOwner["sub-known"]!;
    expect(hb.name).toBe(name);
    expect(hb.kind).toBe("subagent");
    expect(hb.agent_id).toBe("sub-known");
  });

  test("a subagent whose own id is unknown inherits the parent's name via session_id (transient)", () => {
    const root = freshRoot();
    const parentName = assignName(root, "parent-sess", "session");
    // child id NOT in history; session_id IS → resolveName returns parent name, kind transient
    const res = projectHeartbeats(root, [
      toolEvent("child-id", "parent-sess"),
    ] as unknown as Events);
    const hb = res.perOwner["child-id"]!;
    expect(hb.name).toBe(parentName);
    expect(hb.kind).toBe("transient");
  });

  test("an owner with no name-history is still seeded (nameless, no crash)", () => {
    const root = freshRoot();
    const res = projectHeartbeats(root, [toolEvent("no-hist", "no-hist")] as unknown as Events);
    const hb = res.perOwner["no-hist"]!;
    expect(hb).toBeDefined();
    expect(hb.name).toBeUndefined();
  });
});

describe("projectHeartbeats: last_tool_target intent-comment clipping", () => {
  function bashEvent(eventId: string, instanceId: string, command: string): unknown {
    return {
      event_id: eventId,
      event_type: "tool.pre_use",
      ts: "2026-06-04T00:00:01Z",
      instance_id: instanceId,
      session_id: instanceId,
      harness: "claude-code",
      source: "test",
      data: { tool_name: "Bash", tool_input: JSON.stringify({ command }) },
    };
  }

  function target(root: string, command: string): string | undefined {
    const res = projectHeartbeats(root, [
      bashEvent("01CMD", "cmd-owner", command),
    ] as unknown as Events);
    return res.perOwner["cmd-owner"]!.last_tool_target;
  }

  test("strips a leading '# intent:' comment line, target is the real command", () => {
    expect(
      target(freshRoot(), "# intent: sync the vendor mirror\nbash scripts/sync-clients.sh"),
    ).toBe("bash scripts/sync-clients.sh");
  });

  test("skips multiple leading comment + blank lines", () => {
    expect(target(freshRoot(), "# intent: do it\n\n# another note\ngit status")).toBe("git status");
  });

  test("a single-line command with no comment is unchanged", () => {
    expect(target(freshRoot(), "git push origin main")).toBe("git push origin main");
  });

  test("an inline '#' inside a real command line is preserved (not a comment)", () => {
    expect(target(freshRoot(), "grep '#fff' styles.css")).toBe("grep '#fff' styles.css");
  });

  test("file_path tools are unaffected by the command clip", () => {
    const root = freshRoot();
    const ev = {
      event_id: "01READ",
      event_type: "tool.pre_use",
      ts: "2026-06-04T00:00:01Z",
      instance_id: "read-owner",
      session_id: "read-owner",
      harness: "claude-code",
      source: "test",
      data: { tool_name: "Read", tool_input: JSON.stringify({ file_path: "/repo/x.ts" }) },
    };
    const res = projectHeartbeats(root, [ev] as unknown as Events);
    expect(res.perOwner["read-owner"]!.last_tool_target).toBe("/repo/x.ts");
  });
});

/**
 * Locks claim.release durability: the projector rebuilds files_touched from
 * permanent Edit/Write events, so a release only survives a full replay if a
 * claim.release event exists in the stream AND the projector's subtraction
 * matches across path forms (Edit events report absolute-under-coordRoot;
 * release-claim canonicalizes to repo-relative). The exact-string compare this
 * replaces silently no-op'd on the form mismatch, resurrecting released claims
 * on the next replayAll drain.
 */
describe("projectHeartbeats: claim.release durability + path-form normalization", () => {
  const OWNER = "rel-owner";

  function editEvent(file: string, ts: string, id: string) {
    return {
      event_id: id,
      event_type: "tool.pre_use",
      ts,
      instance_id: OWNER,
      session_id: OWNER,
      harness: "claude-code",
      source: "test",
      data: { tool_name: "Edit", tool_input: JSON.stringify({ file_path: file }) },
    };
  }

  function releaseEvent(p: string, ts: string, id: string) {
    return {
      event_id: id,
      event_type: "claim.release",
      ts,
      instance_id: OWNER,
      session_id: OWNER,
      harness: "claude-code",
      source: "agent-coord",
      data: { path: p, reason: "explicit" },
    };
  }

  test("absolute Edit claim is subtracted by a repo-relative release on full replay", () => {
    const root = freshRoot();
    const events = [
      editEvent(`${root}/src/a.ts`, "2026-06-04T00:00:01Z", "01REL01"),
      releaseEvent("src/a.ts", "2026-06-04T00:00:02Z", "01REL02"),
    ] as unknown as Events;
    const res = projectHeartbeats(root, events);
    expect(res.perOwner[OWNER]!.files_touched).toEqual([]);
  });

  test("repo-relative claim is subtracted by an absolute release", () => {
    const root = freshRoot();
    const events = [
      editEvent("src/b.ts", "2026-06-04T00:00:01Z", "01REL03"),
      releaseEvent(`${root}/src/b.ts`, "2026-06-04T00:00:02Z", "01REL04"),
    ] as unknown as Events;
    const res = projectHeartbeats(root, events);
    expect(res.perOwner[OWNER]!.files_touched).toEqual([]);
  });

  test("an Edit AFTER the release legitimately re-claims the path (stored canonical)", () => {
    const root = freshRoot();
    const events = [
      editEvent(`${root}/src/c.ts`, "2026-06-04T00:00:01Z", "01REL05"),
      releaseEvent("src/c.ts", "2026-06-04T00:00:02Z", "01REL06"),
      editEvent(`${root}/src/c.ts`, "2026-06-04T00:00:03Z", "01REL07"),
    ] as unknown as Events;
    const res = projectHeartbeats(root, events);
    expect(res.perOwner[OWNER]!.files_touched).toEqual(["src/c.ts"]);
  });

  test("release of one path leaves sibling claims intact (stored canonical)", () => {
    const root = freshRoot();
    const events = [
      editEvent(`${root}/src/keep.ts`, "2026-06-04T00:00:01Z", "01REL08"),
      editEvent(`${root}/src/drop.ts`, "2026-06-04T00:00:02Z", "01REL09"),
      releaseEvent("src/drop.ts", "2026-06-04T00:00:03Z", "01REL10"),
    ] as unknown as Events;
    const res = projectHeartbeats(root, events);
    expect(res.perOwner[OWNER]!.files_touched).toEqual(["src/keep.ts"]);
  });

  test("absolute + relative Edits of the same file project to ONE canonical claim", () => {
    const root = freshRoot();
    const events = [
      editEvent(`${root}/src/d.ts`, "2026-06-04T00:00:01Z", "01REL11"),
      editEvent("src/d.ts", "2026-06-04T00:00:02Z", "01REL12"),
    ] as unknown as Events;
    const res = projectHeartbeats(root, events);
    expect(res.perOwner[OWNER]!.files_touched).toEqual(["src/d.ts"]);
  });
});
