import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  findRemoteDecisionRow,
  reachCommand,
  readRemoteDocketSnapshot,
  remoteDecisionHref,
} from "./remote-docket-reader";

const NOW = new Date("2026-11-14T12:00:00Z");
const roots: string[] = [];

function git(root: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: root,
    windowsHide: true,
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  }).trim();
}

/** A temp coord root with real `refs/harnery/docket/<ref>` commits, one per entry. */
function rootWithRefs(refs: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "remote-docket-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  const tree = git(root, ["mktree"], "");
  for (const [ref, message] of Object.entries(refs)) {
    const sha = git(root, ["commit-tree", tree, "-F", "-"], message);
    git(root, ["update-ref", `refs/harnery/docket/${ref}`, sha]);
  }
  return root;
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function blob(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    kind: "docket",
    machine: "laptop",
    machine_id: "aaaaaaaaaaaa",
    published_at: "2026-11-14T11:50:00Z",
    decisions: [
      {
        decision_id: "low-2026-11-13-aaaa",
        question: "Low stakes waiting?",
        tier: 2,
        stakes: "small",
        status: "filed",
        waiting: true,
        filed_at: "2026-11-13T10:00:00Z",
        filed_by: "Quill",
      },
      {
        decision_id: "high-2026-11-14-bbbb",
        question: "High stakes waiting?",
        tier: 2,
        stakes: "high",
        status: "filed",
        waiting: true,
        filed_at: "2026-11-14T10:00:00Z",
        brief: "Brief body",
      },
      {
        decision_id: "done-2026-11-12-cccc",
        question: "Already decided?",
        tier: 1,
        stakes: "medium",
        status: "resolved",
        waiting: false,
        filed_at: "2026-11-12T10:00:00Z",
        resolution_summary: "Went with A",
      },
    ],
    approvals: [
      {
        id: "apr-0123456789abcdef0123",
        run_id: "run-1",
        status: "pending",
        requested_at: "2026-11-14T11:00:00Z",
        addressed_to: "operator",
        phase: "act",
        action: "deploy",
      },
    ],
    truncated: { waiting: 0, recent: 2, approvals: 0, briefs: 0 },
    ...over,
  });
}

const deps = (root: string, extra: Record<string, unknown> = {}) => ({
  root,
  now: NOW,
  presenceEnabled: () => true,
  docketShareEnabled: () => true,
  readPresenceAgents: () => [{ machine: "laptop", agents: [{ name: "Wren" }] }],
  ...extra,
});

describe("readRemoteDocketSnapshot", () => {
  test("splits waiting from recent, sorts waiting by stakes, keeps approvals", () => {
    const snap = readRemoteDocketSnapshot(deps(rootWithRefs({ laptop: blob() })));
    expect(snap.error).toBeNull();
    expect(snap.waiting.map((r) => r.decision.decision_id)).toEqual([
      "high-2026-11-14-bbbb",
      "low-2026-11-13-aaaa",
    ]);
    expect(snap.recent.map((r) => r.decision.decision_id)).toEqual(["done-2026-11-12-cccc"]);
    expect(snap.approvals).toHaveLength(1);
    expect(snap.machines).toEqual([
      expect.objectContaining({ ref: "laptop", label: "laptop", stale: false, truncated: 2 }),
    ]);
    expect(snap.malformed).toEqual([]);
  });

  test("contact prefers the filer, then an agent presence lists on that machine", () => {
    const snap = readRemoteDocketSnapshot(deps(rootWithRefs({ laptop: blob() })));
    const low = findRemoteDecisionRow(snap, "low-2026-11-13-aaaa");
    const high = findRemoteDecisionRow(snap, "high-2026-11-14-bbbb");
    expect(low?.source.contact).toBe("Quill");
    expect(high?.source.contact).toBe("Wren");
    expect(snap.approvals[0]?.source.contact).toBe("Wren");
    expect(reachCommand("mybin", low!.source)).toBe('mybin agents ping Quill "<message>"');
    expect(reachCommand("mybin", { ...low!.source, contact: null })).toBeNull();
    expect(remoteDecisionHref(low!)).toBe("/decisions/low-2026-11-13-aaaa?from=laptop");
  });

  test("a malformed blob is reported by ref and the good one still renders", () => {
    const snap = readRemoteDocketSnapshot(
      deps(rootWithRefs({ laptop: blob(), broken: "{not json", oldver: blob({ v: 9 }) })),
    );
    expect(snap.malformed.sort()).toEqual(["broken", "oldver"]);
    expect(snap.machines.map((m) => m.ref)).toEqual(["laptop"]);
  });

  test("a stale docket is kept and flagged", () => {
    const snap = readRemoteDocketSnapshot(
      deps(rootWithRefs({ laptop: blob({ published_at: "2026-11-14T06:00:00Z" }) })),
    );
    expect(snap.machines[0]?.stale).toBe(true);
    expect(snap.waiting[0]?.source.stale).toBe(true);
  });

  test("withdrawn and expired dockets show nothing", () => {
    const snap = readRemoteDocketSnapshot(
      deps(
        rootWithRefs({
          gone: blob({ machine: "gone", machine_id: "bbbbbbbbbbbb", withdrawn: true }),
          ancient: blob({
            machine: "ancient",
            machine_id: "cccccccccccc",
            published_at: "2026-10-01T00:00:00Z",
          }),
        }),
      ),
    );
    expect(snap.machines).toEqual([]);
    expect(snap.waiting).toEqual([]);
  });

  test("no refs at all is an empty, error-free snapshot", () => {
    const snap = readRemoteDocketSnapshot(deps(rootWithRefs({})));
    expect(snap).toMatchObject({ presence: true, error: null, machines: [], malformed: [] });
  });

  test("presence off short-circuits without reading refs", () => {
    let read = false;
    const snap = readRemoteDocketSnapshot(
      deps(rootWithRefs({ laptop: blob() }), {
        presenceEnabled: () => false,
        readRemoteDockets: () => {
          read = true;
          return { dockets: [], skipped: [] };
        },
      }),
    );
    expect(read).toBe(false);
    expect(snap).toMatchObject({ presence: false, machines: [], error: null });
  });

  test("a throwing core reader degrades to an error, never a throw", () => {
    const snap = readRemoteDocketSnapshot(
      deps(rootWithRefs({}), {
        readRemoteDockets: () => {
          throw new Error("boom");
        },
      }),
    );
    expect(snap.error).toBe("boom");
    expect(snap.waiting).toEqual([]);
  });

  test("findRemoteDecisionRow honours a pinned source ref", () => {
    const snap = readRemoteDocketSnapshot(deps(rootWithRefs({ laptop: blob() })));
    expect(findRemoteDecisionRow(snap, "low-2026-11-13-aaaa", "laptop")).not.toBeNull();
    expect(findRemoteDecisionRow(snap, "low-2026-11-13-aaaa", "other")).toBeNull();
    expect(findRemoteDecisionRow(snap, "missing")).toBeNull();
  });
});

test("dashboard uses one core read and never creates local machine state", () => {
  const root = rootWithRefs({ laptop: blob(), broken: "{not json" });
  const snap = readRemoteDocketSnapshot(deps(root));
  expect(snap.malformed).toEqual(["broken"]);
  expect(snap.waiting).toHaveLength(2);
  expect(existsSync(join(root, ".harnery"))).toBe(false);
  let reads = 0;
  const fromCore = readRemoteDocketSnapshot(
    deps(root, {
      readRemoteDockets: () => {
        reads++;
        return {
          dockets: [],
          skipped: [
            { ref: "only-in-core", reason: "invalid_blob" },
            { ref: "gone", reason: "withdrawn" },
          ],
        };
      },
    }),
  );
  expect(reads).toBe(1);
  expect(fromCore.malformed).toEqual(["only-in-core"]);
});
