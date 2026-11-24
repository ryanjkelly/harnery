import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdmissionEntry } from "../../lib/admission.ts";
import {
  agentLabel,
  clearCommitActivity,
  commitActivityFor,
  describeCommitActivity,
  findGitAncestor,
  listCommitActivity,
  recordCommitStart,
} from "./git-activity.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-activity-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const alive = () => true;
const same = () => "same" as const;

describe("recordCommitStart", () => {
  test("records the session, repository and git process", () => {
    const record = recordCommitStart(root, root, {
      identity: { instance_id: "inst-a", agent: "Bonnie" },
      gitPid: process.pid,
      repo: join(root, "web"),
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(record).toMatchObject({
      instance_id: "inst-a",
      agent: "Bonnie",
      repo: join(root, "web"),
      git_pid: process.pid,
      started_at: "2026-01-01T00:00:00.000Z",
    });
    expect(existsSync(join(root, ".harnery", "git-activity", `${process.pid}.json`))).toBe(true);
  });

  test("records nothing when the committing session cannot be resolved", () => {
    const record = recordCommitStart(root, root, {
      identity: null,
      gitPid: process.pid,
      repo: root,
    });
    expect(record).toBeNull();
    expect(listCommitActivity(root, { alive, generation: same })).toEqual([]);
  });

  test("records nothing outside a git process", () => {
    const record = recordCommitStart(root, root, {
      identity: { instance_id: "inst-a" },
      gitPid: null,
      repo: root,
    });
    expect(record).toBeNull();
  });
});

describe("listCommitActivity", () => {
  test("keeps live records and prunes records whose git process is gone", () => {
    recordCommitStart(root, root, {
      identity: { instance_id: "inst-live" },
      gitPid: 111,
      repo: root,
    });
    recordCommitStart(root, root, {
      identity: { instance_id: "inst-dead" },
      gitPid: 222,
      repo: root,
    });
    const live = listCommitActivity(root, { alive: (pid) => pid === 111, generation: same });
    expect(live.map((record) => record.instance_id)).toEqual(["inst-live"]);
    expect(existsSync(join(root, ".harnery", "git-activity", "222.json"))).toBe(false);
  });

  test("drops a record whose pid now belongs to a different process", () => {
    recordCommitStart(root, root, {
      identity: { instance_id: "inst-a" },
      gitPid: 333,
      repo: root,
    });
    const live = listCommitActivity(root, { alive, generation: () => "different" });
    expect(live).toEqual([]);
  });

  test("ignores and removes unparseable files", () => {
    const dir = join(root, ".harnery", "git-activity");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "444.json"), "{not json");
    expect(listCommitActivity(root, { alive, generation: same })).toEqual([]);
    expect(existsSync(join(dir, "444.json"))).toBe(false);
  });
});

test("clearCommitActivity removes the commit's record", () => {
  recordCommitStart(root, root, { identity: { instance_id: "inst-a" }, gitPid: 555, repo: root });
  clearCommitActivity(root, 555);
  expect(existsSync(join(root, ".harnery", "git-activity", "555.json"))).toBe(false);
  // A second clear is harmless.
  clearCommitActivity(root, 555);
});

describe("commitActivityFor", () => {
  const holder = (instance_id: string, label: string): AdmissionEntry => ({
    pid: 1,
    label,
    created_at: "2026-01-01T00:00:00Z",
    instance_id,
  });

  test("filters by repository and session and joins the session's slots", () => {
    const activity = [
      {
        schema_version: 1,
        instance_id: "inst-a",
        agent: "Bonnie",
        repo: join(root, "web"),
        git_pid: 1,
        started_at: "2026-01-01T00:00:00Z",
      },
      {
        schema_version: 1,
        instance_id: "inst-b",
        repo: join(root, "cli"),
        git_pid: 2,
        started_at: "2026-01-01T00:00:00Z",
      },
      {
        schema_version: 1,
        instance_id: "inst-self",
        repo: join(root, "web"),
        git_pid: 3,
        started_at: "2026-01-01T00:00:00Z",
      },
    ];
    const views = commitActivityFor(root, {
      repos: [join(root, "web")],
      excludeInstance: "inst-self",
      activity,
      holders: [holder("inst-a", "pre-commit tests"), holder("inst-b", "typecheck")],
    });
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ instance_id: "inst-a", slots: ["pre-commit tests"] });
    expect(describeCommitActivity(views[0]!, { root, now: new Date("2026-01-01T00:04:00Z") })).toBe(
      "web: agent-Bonnie has been committing for 4 min; running pre-commit tests",
    );
  });
});

test("agentLabel falls back to the short instance id", () => {
  expect(agentLabel({ instance_id: "abcdef1234567890" })).toBe("agent-abcdef12");
  expect(agentLabel({ instance_id: "x", agent: "Mira" })).toBe("agent-Mira");
});

test("findGitAncestor walks parents until it reaches git", () => {
  const parents: Record<number, number> = { 10: 20, 20: 30, 30: 40, 40: 1 };
  const names: Record<number, string> = { 20: "bash", 30: "git", 40: "zsh" };
  expect(
    findGitAncestor(10, { ppid: (pid) => parents[pid] ?? null, name: (pid) => names[pid] ?? null }),
  ).toBe(30);
  expect(
    findGitAncestor(10, { ppid: (pid) => parents[pid] ?? null, name: () => "bash" }),
  ).toBeNull();
});
