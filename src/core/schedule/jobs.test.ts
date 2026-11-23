import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleJob, ScheduleJobFile } from "./job-types.ts";
import {
  ensureScheduleJobFileTracked,
  findScheduleExecutableOnPath,
  findScheduleJob,
  loadScheduleJobFile,
  resolveScheduleJob,
  writeScheduleJobFile,
} from "./jobs.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "harnery-schedule-jobs-")));
  mkdirSync(join(root, ".harnery"), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const job = (over: Partial<ScheduleJob> = {}): ScheduleJob => ({
  id: "nightly-check",
  title: "Nightly check",
  host: "box",
  trigger: { type: "cron", expr: "0 3 * * *" },
  timeout_minutes: 10,
  max_launches_per_day: 2,
  gather: [{ name: "status", argv: ["git", "status"] }],
  ...over,
});

function makeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return path;
}

describe("loadScheduleJobFile", () => {
  test("missing", () => {
    const r = loadScheduleJobFile(root);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });
  test("reads JSONC with comments", () => {
    writeFileSync(
      join(root, ".harnery", "schedules.jsonc"),
      `// jobs\n{ "version": 1, /* none yet */ "jobs": [${JSON.stringify(job())}] }\n`,
    );
    const r = loadScheduleJobFile(root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toBe(join(root, ".harnery", "schedules.jsonc"));
      expect(findScheduleJob(r.file, "nightly-check")?.title).toBe("Nightly check");
      expect(findScheduleJob(r.file, "nope")).toBeNull();
    }
  });
  test("invalid lists errors", () => {
    writeFileSync(join(root, ".harnery", "schedules.jsonc"), `{ "version": 2, "jobs": [] }`);
    const r = loadScheduleJobFile(root);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("invalid");
      expect(r.errors.join("\n")).toContain("file.version");
    }
  });
});

describe("writeScheduleJobFile", () => {
  test("writes pretty JSON that loads back", () => {
    const file: ScheduleJobFile = { version: 1, jobs: [job()] };
    writeScheduleJobFile(root, file);
    const text = readFileSync(join(root, ".harnery", "schedules.jsonc"), "utf8");
    expect(text).toContain('\n  "jobs"');
    const r = loadScheduleJobFile(root);
    expect(r.ok && r.file).toEqual(file);
  });
  test("refuses an invalid file", () => {
    expect(() => writeScheduleJobFile(root, { version: 1, jobs: [job({ id: "Bad Id" })] })).toThrow(
      /invalid/,
    );
  });
});

describe("resolveScheduleJob", () => {
  test("PATH name, relative path and absolute path", () => {
    const bin = join(root, "bin");
    const onPath = makeExecutable(bin, "tool");
    const local = makeExecutable(join(root, "scripts"), "check.sh");
    const absolute = makeExecutable(join(root, "abs"), "run");
    const j = job({
      gather: [
        { name: "a", argv: ["tool", "--flag"] },
        { name: "b", argv: ["scripts/check.sh"] },
        { name: "c", argv: [absolute] },
        { name: "d", argv: ["not-a-real-tool-xyz"] },
      ],
    });
    const r = resolveScheduleJob(j, { coordRoot: root, env: { PATH: bin } });
    expect(r.executables).toEqual([onPath, local, absolute, ""]);
    expect(r.missing).toEqual(["not-a-real-tool-xyz"]);
    expect(typeof r.zone).toBe("string");
  });
  test("follows symlinks to the real path", () => {
    const real = makeExecutable(join(root, "real"), "tool");
    mkdirSync(join(root, "links"));
    symlinkSync(real, join(root, "links", "tool"));
    const r = resolveScheduleJob(job({ gather: [{ name: "a", argv: ["tool"] }] }), {
      coordRoot: root,
      env: { PATH: join(root, "links") },
    });
    expect(r.executables).toEqual([real]);
  });
  test("an injected lookup is used for bare names", () => {
    const real = makeExecutable(join(root, "x"), "tool");
    const r = resolveScheduleJob(job({ gather: [{ name: "a", argv: ["tool"] }] }), {
      coordRoot: root,
      env: {},
      pathLookup: (name) => (name === "tool" ? real : null),
    });
    expect(r.executables).toEqual([real]);
    expect(r.missing).toEqual([]);
  });
  test("an agent-only job resolves no executables", () => {
    const { gather: _drop, ...rest } = job();
    const r = resolveScheduleJob(
      { ...rest, agent: { adapter: "codex", prompt: "Look." } },
      {
        coordRoot: root,
        env: {},
      },
    );
    expect(r.executables).toEqual([]);
  });
});

describe("findScheduleExecutableOnPath on Windows rules", () => {
  test("tries PATHEXT extensions and a case-insensitive Path variable", () => {
    const dir = join(root, "win");
    mkdirSync(dir);
    writeFileSync(join(dir, "tool.CMD"), "@echo off\n");
    const found = findScheduleExecutableOnPath(
      "tool",
      { Path: dir, PATHEXT: ".EXE;.CMD" },
      "win32",
    );
    expect(found?.endsWith("tool.CMD")).toBe(true);
    expect(
      findScheduleExecutableOnPath("tool", { Path: dir, PATHEXT: ".EXE" }, "win32"),
    ).toBeNull();
  });
});

describe("ensureScheduleJobFileTracked", () => {
  const gitignore = () => join(root, ".harnery", ".gitignore");
  test("adds the line and keeps the rest", () => {
    writeFileSync(gitignore(), "*\n!.gitignore\n!config.jsonc\n");
    expect(ensureScheduleJobFileTracked(root)).toEqual({ changed: true });
    expect(readFileSync(gitignore(), "utf8")).toBe(
      "*\n!.gitignore\n!config.jsonc\n!schedules.jsonc\n",
    );
    expect(ensureScheduleJobFileTracked(root)).toEqual({ changed: false });
  });
  test("handles a file without a final newline", () => {
    writeFileSync(gitignore(), "*\n!.gitignore");
    ensureScheduleJobFileTracked(root);
    expect(readFileSync(gitignore(), "utf8")).toBe("*\n!.gitignore\n!schedules.jsonc\n");
  });
  test("no-op without a .gitignore", () => {
    expect(ensureScheduleJobFileTracked(root)).toEqual({ changed: false });
  });
});
