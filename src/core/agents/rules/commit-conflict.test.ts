import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
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
  rmSync(root, { recursive: true, force: true });
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

function commitVerdict(stagedPaths: string[]) {
  return evaluateCommit(root, {
    instance_id: "self",
    session_id: "self",
    staged_paths: stagedPaths,
  });
}
