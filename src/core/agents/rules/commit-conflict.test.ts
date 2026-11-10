import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import {
  recordLiveDelegatedChildSessionV3,
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../events/v3/live-routing.ts";
import { recordLiveClaimChangeV3 } from "../live-authority-v3.ts";
import { readLiveCoordinationRow } from "../state/live-coordination-view.ts";
import { evaluateCommit } from "./commit-conflict.ts";

let root: string;
const IDENTITY_ENV = [
  "HARNERY_AGENT_COORD_BRIDGE",
  "HARNERY_AGENT_COORD_OWNER",
  "HARNERY_AGENT_COORD_PLATFORM",
  "HARNERY_AGENT_COORD_SESSION_ID",
  "CODEX_THREAD_ID",
] as const;
const savedIdentityEnv = IDENTITY_ENV.map((key) => [key, process.env[key]] as const);

beforeEach(() => {
  root = join(tmpdir(), `harnery-commit-v3-${process.pid}-${crypto.randomUUID()}`);
  initializeV3Fixture(root);
  for (const key of IDENTITY_ENV) delete process.env[key];
});

afterEach(() => {
  removeDir(root);
  for (const [key, value] of savedIdentityEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("evaluateCommit on canonical V3 authority", () => {
  test("an empty staged set passes without coordination state", () => {
    expect(
      evaluateCommit(root, { instance_id: "self", session_id: "self", staged_paths: [] }),
    ).toMatchObject({ allow: true, rule: "commit.pass" });
  });

  test("a staged path with no peer claim passes", () => {
    seedV3Session(root, "self", { name: "Maya" });
    expect(commitVerdict(["docs/x.md"])).toMatchObject({ allow: true });
  });

  test("a peer claim on a staged path blocks the commit", () => {
    seedV3Session(root, "self", { name: "Maya" });
    seedV3Session(root, "peer", {
      name: "Adelaide",
      claims: ["docs/shared.md", "docs/peer-only.md"],
    });
    const result = commitVerdict(["docs/shared.md"]);
    expect(result.allow).toBe(false);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.short_name).toContain("Adelaide");
  });

  test("a blocked committer retains the path so the holder cannot sweep its edits", () => {
    seedV3Session(root, "self", {
      name: "Maya",
      sessionId: "codex-thread-self",
      adapter: "codex",
    });
    seedV3Session(root, "peer", {
      name: "Adelaide",
      sessionId: "codex-thread-peer",
      adapter: "codex",
      claims: ["docs/shared.md"],
    });

    expect(
      evaluateCommit(root, {
        instance_id: "self",
        session_id: "codex-thread-self",
        staged_paths: ["docs/shared.md"],
      }),
    ).toMatchObject({
      allow: false,
      rule: "commit.conflict",
    });
    expect(readLiveCoordinationRow(root, "self")?.files_touched).toContain("docs/shared.md");

    const holderAttempt = evaluateCommit(root, {
      instance_id: "peer",
      session_id: "codex-thread-peer",
      staged_paths: ["docs/shared.md"],
    });
    expect(holderAttempt).toMatchObject({ allow: false, rule: "commit.conflict" });
    expect(holderAttempt.conflicts[0]?.instance_id).toBe("self");
  });

  test("a resolved committer's own session groups the subagents that carry it", () => {
    seedV3Session(root, "self", { name: "Maya", sessionId: "sid-parent" });
    seedV3Child(root, { parent: "self", parentSession: "sid-parent", child: "child" });
    recordLiveClaimChangeV3({
      coordRoot: root,
      owner: "child",
      nativeSessionId: "sid-parent",
      adapter: "codex",
      operation: "acquired",
      path: "docs/shared.md",
      access: "write",
    });
    recordLiveClaimChangeV3({
      coordRoot: root,
      owner: "child",
      nativeSessionId: "sid-parent",
      adapter: "codex",
      operation: "acquired",
      path: "docs/child-only.md",
      access: "write",
    });
    expect(readLiveCoordinationRow(root, "child")?.session_id).toBe(
      readLiveCoordinationRow(root, "self")?.session_id,
    );
    seedV3Session(root, "peer", {
      name: "Adelaide",
      sessionId: "sid-peer",
      claims: ["docs/peer.md", "docs/peer-only.md"],
    });
    // The hook passes no session; the committer's row supplies it.
    expect(
      evaluateCommit(root, { instance_id: "self", staged_paths: ["docs/shared.md"] }),
    ).toMatchObject({ allow: true, rule: "commit.pass", conflicts: [] });
    // A different session still blocks.
    expect(
      evaluateCommit(root, { instance_id: "self", staged_paths: ["docs/peer.md"] }),
    ).toMatchObject({ allow: false, rule: "commit.conflict" });
  });

  test("the self-attribution suppression remains explicit", () => {
    seedV3Session(root, "self", { name: "Maya", adapter: "claude-code" });
    seedV3Session(root, "peer", {
      name: "Adelaide",
      adapter: "claude-code",
      claims: ["docs/shared.md"],
    });
    expect(commitVerdict(["docs/shared.md"])).toMatchObject({
      allow: true,
      rule: "commit.suppressed",
      suppressed_self_attribution: true,
    });
  });

  test("a refreshed Codex bridge recognizes its own canonical V3 claim", () => {
    seedV3Session(root, "self", {
      name: "Maya",
      sessionId: "codex-thread-self",
      adapter: "codex",
      claims: ["docs/shared.md"],
    });
    seedV3Session(root, "other", {
      name: "Adelaide",
      sessionId: "codex-thread-other",
      adapter: "codex",
      claims: ["docs/other.md"],
    });
    process.env.HARNERY_AGENT_COORD_BRIDGE = "codex-wsl";
    process.env.HARNERY_AGENT_COORD_OWNER = "other";
    process.env.HARNERY_AGENT_COORD_PLATFORM = "codex";
    process.env.HARNERY_AGENT_COORD_SESSION_ID = "codex-thread-self";
    process.env.CODEX_THREAD_ID = "codex-thread-self";

    expect(evaluateCommit(root, { staged_paths: ["docs/shared.md"] })).toMatchObject({
      allow: true,
      rule: "commit.pass",
      instance_id: "self",
      conflicts: [],
    });
  });
});

/** Register `child` as a delegated subagent of the already-started `parent`. */
function seedV3Child(
  coordRoot: string,
  ids: { parent: string; parentSession: string; child: string },
): void {
  const route = resolveLiveEventLedgerRouteV3(coordRoot);
  if (route.state !== "v3") throw new Error("expected V3 route");
  const payload = { session_id: ids.parentSession, agent_id: ids.child, raw: {} };
  const start = recordLiveHookSignalV3({
    coordRoot,
    route,
    eventName: "sub-agent-start",
    payload,
    adapter: "codex",
    instanceId: ids.parent,
  });
  if (start.state !== "recorded" || start.event.event_type !== "agent.started") {
    throw new Error(`fixture_child_start:${start.state}`);
  }
  const child = recordLiveDelegatedChildSessionV3({
    coordRoot,
    route,
    parentEvent: start.event,
    payload: { ...payload, turn_id: "child-turn" },
    adapter: "codex",
  });
  if (child.state !== "recorded") throw new Error(`fixture_child_session:${child.state}`);
}

function commitVerdict(stagedPaths: string[]) {
  return evaluateCommit(root, {
    instance_id: "self",
    session_id: "self",
    staged_paths: stagedPaths,
  });
}
