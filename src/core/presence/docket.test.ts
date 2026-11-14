import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { fileDecision, resolveDecision } from "../../lib/decision/index.ts";
import { createWorkflowApproval } from "../run/approvals.ts";
import {
  buildDocketBlob,
  chooseDocketRef,
  DOCKET_STALE_SECS,
  docketMachineId,
  docketShareEnabled,
  findRemoteApproval,
  findRemoteDecision,
  parseDocketBlob,
  publishDocket,
  readRemoteDockets,
  searchRemoteDecisions,
} from "./docket.ts";
import { DOCKET_REF_PREFIX, pushMachineRef, writePresenceCommit } from "./git.ts";
import { fetchPresence, publishPresence } from "./index.ts";

/**
 * Shared docket (ADR 0255) against real git repos: a bare temp "origin" and
 * two clones standing in for two machines. Never touches a real remote.
 */

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function share(root: string, on: boolean): void {
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    `// test config\n{ "decision": { "share": ${on} } }\n`,
  );
}

function fileWaiting(root: string, question: string, brief?: string): string {
  const r = fileDecision(root, {
    question,
    tier: 2,
    stakes: "high",
    filedBy: "agent-Filer",
    ...(brief ? { brief } : {}),
  });
  if (!r.ok || !r.manifest) throw new Error(r.reason);
  return r.manifest.decision_id;
}

function parkApproval(root: string, runId: string): string {
  const { approval } = createWorkflowApproval({
    coordRoot: root,
    runId,
    decisionId: "p1",
    policy: { name: "test-policy", sha256: "a".repeat(64) },
    request: {
      phase: "dispatch",
      action: "spawn helper",
      isolation: "shared",
      network_access: "unknown",
    } as never,
    evaluation: {
      verdict: "ask",
      reason: "needs a person",
      rules: [{ code: "r1", verdict: "ask", reason: "needs a person" }],
    } as never,
  });
  return approval.request.id;
}

let base: string;
let origin: string;
let cloneA: string;
let cloneB: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-docket-"));
  origin = join(base, "origin.git");
  cloneA = join(base, "a");
  cloneB = join(base, "b");
  spawnSync("git", ["init", "--bare", origin], { encoding: "utf8" });
  for (const c of [cloneA, cloneB]) {
    spawnSync("git", ["init", c], { encoding: "utf8" });
    git(c, "remote", "add", "origin", origin);
    mkdirSync(join(c, ".harnery"), { recursive: true });
  }
  for (const k of ["HARNERY_MACHINE", "HARNERY_PRESENCE", "HARNERY_DOCKET_SHARE"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.HARNERY_PRESENCE = "1";
  delete process.env.HARNERY_DOCKET_SHARE;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeDir(base);
});

describe("docketShareEnabled", () => {
  test("off by default, on with decision.share, env overrides, needs presence", () => {
    expect(docketShareEnabled(cloneA)).toBe(false);
    share(cloneA, true);
    expect(docketShareEnabled(cloneA)).toBe(true);
    process.env.HARNERY_DOCKET_SHARE = "0";
    expect(docketShareEnabled(cloneA)).toBe(false);
    process.env.HARNERY_DOCKET_SHARE = "1";
    process.env.HARNERY_PRESENCE = "0";
    expect(docketShareEnabled(cloneA)).toBe(false);
  });

  test("sharing off publishes nothing", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    fileWaiting(cloneA, "Should we pick option A?");
    expect(publishDocket(cloneA, { sync: true }).status).toBe("skipped");
    expect(git(origin, "for-each-ref", `${DOCKET_REF_PREFIX}*`)).toBe("");
  });
});

describe("buildDocketBlob", () => {
  test("includes waiting decisions, recent changes, and pending approvals", () => {
    const waiting = fileWaiting(cloneA, "Which vendor should we use?", "Long brief text");
    const done = fileDecision(cloneA, { question: "Rename the flag?", tier: 1, stakes: "small" });
    resolveDecision(cloneA, done.manifest!.decision_id, {
      recommendation: "Keep the current name",
      evidence: ["read the call sites"],
      resolved_by: "agent-Solver",
    });
    const apr = parkApproval(cloneA, "run-1");
    const { blob } = buildDocketBlob(cloneA, { machine: "machine-a", machineId: "abcdef123456" });
    const w = blob.decisions.find((d) => d.decision_id === waiting);
    expect(w).toMatchObject({ waiting: true, tier: 2, stakes: "high", brief: "Long brief text" });
    const r = blob.decisions.find((d) => d.decision_id === done.manifest!.decision_id);
    expect(r).toMatchObject({ waiting: false, resolution_summary: "Keep the current name" });
    expect(blob.approvals.map((a) => a.id)).toEqual([apr]);
    expect(blob.truncated).toEqual({ waiting: 0, recent: 0, approvals: 0, briefs: 0 });
  });

  test("count and byte caps truncate and say so", () => {
    for (let i = 0; i < 5; i++) fileWaiting(cloneA, `Question number ${i}?`, "x".repeat(1500));
    const counted = buildDocketBlob(cloneA, {
      machine: "m",
      machineId: "abcdef123456",
      limits: { waiting: 3 },
    });
    expect(counted.blob.decisions).toHaveLength(3);
    expect(counted.blob.truncated.waiting).toBe(2);

    const sized = buildDocketBlob(cloneA, {
      machine: "m",
      machineId: "abcdef123456",
      limits: { bytes: 4000 },
    });
    expect(Buffer.byteLength(sized.json)).toBeLessThanOrEqual(4000);
    expect(sized.blob.truncated.briefs).toBeGreaterThan(0);
    expect(sized.blob.decisions.some((d) => d.brief_truncated)).toBe(true);
  });
});

describe("publish → fetch → read", () => {
  test("machine B sees machine A's docket, labelled and read-only data", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    share(cloneA, true);
    const id = fileWaiting(cloneA, "Do we migrate the queue this week?");
    const apr = parkApproval(cloneA, "run-7");
    // publishPresence carries the docket even with no live sessions.
    publishPresence(cloneA, { sync: true });
    expect(git(origin, "for-each-ref", `${DOCKET_REF_PREFIX}*`)).toContain(
      `${DOCKET_REF_PREFIX}machine-a`,
    );

    process.env.HARNERY_MACHINE = "machine-b";
    expect(fetchPresence(cloneB, { force: true, sync: true }).status).toBe("fetched");
    const dockets = readRemoteDockets(cloneB);
    expect(dockets).toHaveLength(1);
    expect(dockets[0]).toMatchObject({
      machine: "machine-a",
      stale: false,
      label_collision: false,
    });
    expect(findRemoteDecision(dockets, id)?.decision.filed_by).toBe("agent-Filer");
    expect(findRemoteApproval(dockets, apr)?.approval.run_id).toBe("run-7");
    expect(searchRemoteDecisions(dockets, "migrate the queue")).toHaveLength(1);

    // A reads its own fetched ref: excluded by clone id.
    fetchPresence(cloneA, { force: true, sync: true });
    expect(readRemoteDockets(cloneA)).toHaveLength(0);
  });

  test("unchanged docket is skipped; turning sharing off withdraws it", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    share(cloneA, true);
    fileWaiting(cloneA, "Keep or drop the old flag?");
    const t0 = new Date("2026-01-01T00:00:00Z");
    expect(publishDocket(cloneA, { sync: true, now: t0 }).status).toBe("published");
    const t1 = new Date(t0.getTime() + 60_000);
    expect(publishDocket(cloneA, { sync: true, now: t1 }).status).toBe("skipped");

    share(cloneA, false);
    const t2 = new Date(t0.getTime() + 120_000);
    expect(publishDocket(cloneA, { sync: true, now: t2 }).status).toBe("published");
    process.env.HARNERY_MACHINE = "machine-b";
    fetchPresence(cloneB, { force: true, sync: true });
    expect(readRemoteDockets(cloneB, { now: t2 })).toHaveLength(0);
    // Already withdrawn: nothing further to say.
    expect(publishDocket(cloneA, { sync: true }).status).toBe("skipped");
  });

  test("stale dockets are flagged, malformed ones dropped", () => {
    process.env.HARNERY_MACHINE = "machine-a";
    share(cloneA, true);
    fileWaiting(cloneA, "Old question?");
    const old = new Date(Date.now() - (DOCKET_STALE_SECS + 600) * 1000);
    expect(publishDocket(cloneA, { sync: true, now: old }).status).toBe("published");
    const junk = writePresenceCommit(cloneA, "{not json");
    pushMachineRef(cloneA, DOCKET_REF_PREFIX, "broken", junk!, { sync: true });
    const wrongShape = writePresenceCommit(cloneA, JSON.stringify({ v: 1, kind: "docket" }));
    pushMachineRef(cloneA, DOCKET_REF_PREFIX, "partial", wrongShape!, { sync: true });

    process.env.HARNERY_MACHINE = "machine-b";
    fetchPresence(cloneB, { force: true, sync: true });
    const dockets = readRemoteDockets(cloneB);
    expect(dockets.map((d) => d.ref)).toEqual(["machine-a"]);
    expect(dockets[0]!.stale).toBe(true);
  });

  test("a failed fetch fails open", () => {
    git(cloneB, "remote", "set-url", "origin", join(base, "missing.git"));
    const r = fetchPresence(cloneB, { force: true, sync: true });
    expect(r.status).toBe("error");
    expect(readRemoteDockets(cloneB)).toEqual([]);
  });
});

describe("label collisions", () => {
  test("a second machine with the same label moves to a suffixed ref", () => {
    process.env.HARNERY_MACHINE = "laptop";
    share(cloneA, true);
    share(cloneB, true);
    fileWaiting(cloneA, "Question from the first laptop?");
    fileWaiting(cloneB, "Question from the second laptop?");
    expect(publishDocket(cloneA, { sync: true })).toMatchObject({ ref: "laptop" });

    fetchPresence(cloneB, { force: true, sync: true });
    const idB = docketMachineId(cloneB);
    expect(chooseDocketRef(cloneB, "laptop", idB, undefined)).toBe(`laptop-${idB.slice(0, 6)}`);
    expect(publishDocket(cloneB, { sync: true })).toMatchObject({
      ref: `laptop-${idB.slice(0, 6)}`,
    });

    fetchPresence(cloneA, { force: true, sync: true });
    const seenByA = readRemoteDockets(cloneA);
    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]!.label_collision).toBe(false);
    const all = readRemoteDockets(cloneA, { includeSelf: true });
    expect(all).toHaveLength(2);
    expect(all.every((d) => d.label_collision)).toBe(true);
  });
});

describe("parseDocketBlob", () => {
  test("drops malformed items but keeps valid ones", () => {
    const blob = parseDocketBlob(
      JSON.stringify({
        v: 1,
        kind: "docket",
        machine: "m",
        machine_id: "abcdef123456",
        published_at: "2026-01-01T00:00:00Z",
        decisions: [
          {
            decision_id: "ok-1",
            question: "q",
            tier: 2,
            stakes: "high",
            status: "filed",
            filed_at: "x",
          },
          {
            decision_id: "../bad",
            question: "q",
            tier: 2,
            stakes: "high",
            status: "filed",
            filed_at: "x",
          },
          "nope",
        ],
        approvals: [{ id: "not-an-id" }],
        truncated: { waiting: -3 },
      }),
    );
    expect(blob?.decisions.map((d) => d.decision_id)).toEqual(["ok-1"]);
    expect(blob?.approvals).toEqual([]);
    expect(blob?.truncated.waiting).toBe(0);
    expect(parseDocketBlob("[]")).toBeNull();
    expect(parseDocketBlob(JSON.stringify({ v: 2, kind: "docket" }))).toBeNull();
  });
});
