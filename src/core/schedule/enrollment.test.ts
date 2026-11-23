import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkScheduleEnrollment,
  enrollScheduleJob,
  readScheduleEnrollment,
  removeScheduleEnrollment,
  scheduleRepoKey,
} from "./enrollment.ts";
import type { ScheduleJob, ScheduleJobResolution } from "./job-types.ts";
import { scheduleEnrollmentPath } from "./paths.ts";

let base: string;
let registryDir: string;
const NOW = new Date("2026-11-22T12:00:00.000Z");
const ORIGIN = "https://example.invalid/repo.git";

function checkout(name: string, origin: string | null = ORIGIN): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: dir, windowsHide: true });
  if (origin)
    spawnSync("git", ["remote", "add", "origin", origin], { cwd: dir, windowsHide: true });
  return dir;
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-enroll-")));
  registryDir = join(base, "registry");
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const job = (over: Partial<ScheduleJob> = {}): ScheduleJob => ({
  id: "nightly-check",
  title: "Nightly check",
  host: "box",
  trigger: { type: "cron", expr: "0 3 * * *" },
  timeout_minutes: 10,
  max_launches_per_day: 2,
  gather: [{ name: "status", argv: ["git", "status"] }],
  agent: { adapter: "codex", prompt: "Read the status." },
  ...over,
});
const resolved = (over: Partial<ScheduleJobResolution> = {}): ScheduleJobResolution => ({
  executables: ["/usr/bin/git"],
  zone: "America/Chicago",
  ...over,
});

function enroll(
  root: string,
  j = job(),
  r: ScheduleJobResolution & { missing?: string[] } = resolved(),
) {
  return enrollScheduleJob({
    coordRoot: root,
    job: j,
    resolved: r,
    machine: "box",
    now: NOW,
    registryDir,
  });
}
function check(root: string, j = job(), r = resolved(), machine = "box") {
  return checkScheduleEnrollment({ coordRoot: root, job: j, resolved: r, machine });
}

describe("enrollScheduleJob and checkScheduleEnrollment", () => {
  test("enroll then check is enrolled", () => {
    const root = checkout("a");
    const r = enrollScheduleJob({
      coordRoot: root,
      job: job(),
      resolved: resolved(),
      machine: "box",
      now: NOW,
      enrolledBy: "agent-Test",
      registryDir,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.enrollment).toMatchObject({
      schema_version: 1,
      job_id: "nightly-check",
      machine: "box",
      checkout: root,
      enrolled_at: NOW.toISOString(),
      enrolled_by: "agent-Test",
    });
    expect(readScheduleEnrollment(root, "nightly-check")).toEqual(r.enrollment);
    expect(check(root).state).toBe("enrolled");
  });

  test("not enrolled", () => {
    expect(check(checkout("a")).state).toBe("not-enrolled");
  });

  test("editing the title, owner or enabled keeps it enrolled", () => {
    const root = checkout("a");
    enroll(root);
    expect(check(root, job({ title: "Renamed", owner: "agent-X", enabled: false })).state).toBe(
      "enrolled",
    );
  });

  test.each([
    ["one argv element", job({ gather: [{ name: "status", argv: ["git", "log"] }] }), resolved()],
    ["the prompt", job({ agent: { adapter: "codex", prompt: "Something else." } }), resolved()],
    ["the trigger", job({ trigger: { type: "cron", expr: "0 4 * * *" } }), resolved()],
    ["the timeout", job({ timeout_minutes: 11 }), resolved()],
    ["the resolved executable", job(), resolved({ executables: ["/opt/git/bin/git"] })],
    ["the zone", job(), resolved({ zone: "UTC" })],
  ])("changing %s gives changed", (_label, changedJob, changedResolved) => {
    const root = checkout("a");
    enroll(root);
    const r = check(root, changedJob, changedResolved);
    expect(r.state).toBe("changed");
  });

  test("wrong host refused", () => {
    const r = enrollScheduleJob({
      coordRoot: checkout("a"),
      job: job({ host: "other" }),
      resolved: resolved(),
      machine: "box",
      now: NOW,
      registryDir,
    });
    expect(r).toMatchObject({ ok: false, reason: "wrong-host" });
  });

  test("missing executable refused", () => {
    const root = checkout("a");
    expect(
      enroll(root, job(), { ...resolved({ executables: [""] }), missing: ["git"] }),
    ).toMatchObject({
      ok: false,
      reason: "missing-executable",
    });
    expect(enroll(root, job(), resolved({ executables: [""] }))).toMatchObject({
      ok: false,
      reason: "missing-executable",
    });
    expect(readScheduleEnrollment(root, "nightly-check")).toBeNull();
  });

  test("a second checkout of the same repository is refused", () => {
    const first = checkout("a");
    const second = checkout("b");
    expect(scheduleRepoKey(first)).toBe(scheduleRepoKey(second));
    expect(enroll(first).ok).toBe(true);
    const r = enroll(second);
    expect(r).toMatchObject({ ok: false, reason: "other-checkout" });
    expect(readScheduleEnrollment(second, "nightly-check")).toBeNull();
    // Enrolling again in the first checkout is fine.
    expect(enroll(first).ok).toBe(true);
  });

  test("another repository on the same machine is not blocked", () => {
    expect(enroll(checkout("a")).ok).toBe(true);
    expect(enroll(checkout("b", "https://example.invalid/other.git")).ok).toBe(true);
  });

  test("without an origin, worktrees share the git common directory key", () => {
    const main = checkout("main", null);
    writeFileSync(join(main, "f.txt"), "x");
    const git = (args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd: main,
        windowsHide: true,
      });
    git(["add", "f.txt"]);
    git(["commit", "-q", "-m", "x"]);
    git(["worktree", "add", "-q", join(base, "wt")]);
    expect(scheduleRepoKey(join(base, "wt"))).toBe(scheduleRepoKey(main));
    expect(enroll(main).ok).toBe(true);
    expect(enroll(join(base, "wt"))).toMatchObject({ ok: false, reason: "other-checkout" });
  });

  test("a registry entry for a checkout that no longer exists is replaced", () => {
    const first = checkout("a");
    const second = checkout("b");
    expect(enroll(first).ok).toBe(true);
    rmSync(first, { recursive: true, force: true });
    expect(enroll(second).ok).toBe(true);
    expect(check(second).state).toBe("enrolled");
  });

  test("removing an enrollment frees the job for another checkout", () => {
    const first = checkout("a");
    const second = checkout("b");
    enroll(first);
    expect(removeScheduleEnrollment(first, "nightly-check", { registryDir })).toEqual({
      removed: true,
    });
    expect(removeScheduleEnrollment(first, "nightly-check", { registryDir })).toEqual({
      removed: false,
    });
    expect(check(first).state).toBe("not-enrolled");
    expect(enroll(second).ok).toBe(true);
  });

  test("wrong machine", () => {
    const root = checkout("a");
    enroll(root);
    expect(check(root, job(), resolved(), "laptop").state).toBe("wrong-machine");
    expect(check(root, job({ host: "laptop" })).state).toBe("wrong-machine");
  });

  test("wrong checkout", () => {
    const root = checkout("a");
    enroll(root);
    const path = scheduleEnrollmentPath(root, "nightly-check");
    const stored = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...stored, checkout: join(base, "elsewhere") }));
    expect(check(root).state).toBe("wrong-checkout");
  });

  test("a corrupt enrollment file reads as null", () => {
    const root = checkout("a");
    enroll(root);
    const path = scheduleEnrollmentPath(root, "nightly-check");
    writeFileSync(path, "{ not json");
    expect(readScheduleEnrollment(root, "nightly-check")).toBeNull();
    writeFileSync(path, JSON.stringify({ schema_version: 1, job_id: "nightly-check" }));
    expect(readScheduleEnrollment(root, "nightly-check")).toBeNull();
    expect(check(root).state).toBe("not-enrolled");
  });
});
