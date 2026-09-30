import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyShare,
  isBytePrefix,
  planShare,
  projectSlug,
  remapHome,
  type ShareOptions,
} from "./claude-desktop-share.ts";

const ACCT = "aaaaaaaa-0000-0000-0000-000000000001";
const NOW = Date.now();
const OLD = NOW - 10 * 60_000;

let root: string;

interface Machine {
  name: string;
  home: string;
  dataDir: string;
  repo: string;
}

function machine(name: string): Machine {
  const home = join(root, name, "home");
  const repo = join(home, "projects", "repo");
  mkdirSync(repo, { recursive: true });
  const dataDir = join(root, name, "desktop");
  mkdirSync(join(dataDir, "claude-code-sessions", ACCT, "env-1"), { recursive: true });
  return { name, home, dataDir, repo };
}

function opts(m: Machine): ShareOptions {
  return {
    shareDir: join(root, "share"),
    machine: m.name,
    days: 14,
    dataDir: m.dataDir,
    targetAccountUuid: ACCT,
    home: m.home,
    now: NOW,
  };
}

function transcriptFile(m: Machine, id: string): string {
  return join(m.home, ".claude", "projects", projectSlug(m.repo), `${id}.jsonl`);
}

function startSession(m: Machine, id: string, title: string, lines: string[]): void {
  writeFileSync(
    join(m.dataDir, "claude-code-sessions", ACCT, "env-1", `local_${id}.json`),
    JSON.stringify({
      sessionId: `local_${id}`,
      cliSessionId: id,
      cwd: m.repo,
      originCwd: m.repo,
      gitAnchors: [{ gitRoot: m.repo, commonDir: join(m.repo, ".git") }],
      title,
      isArchived: false,
      createdAt: OLD,
      lastActivityAt: OLD,
    }),
  );
  const t = transcriptFile(m, id);
  mkdirSync(join(t, ".."), { recursive: true });
  writeFileSync(t, lines.map((l) => `${l}\n`).join(""));
  utimesSync(t, OLD / 1000, OLD / 1000);
}

function sync(m: Machine) {
  const plan = planShare(opts(m));
  applyShare(plan, opts(m));
  return plan;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-share-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("helpers", () => {
  test("projectSlug matches Claude Code's folder naming", () => {
    expect(projectSlug("/Users/me/projects/repo/.claude/worktrees/x-1")).toBe(
      "-Users-me-projects-repo--claude-worktrees-x-1",
    );
  });

  test("remapHome rewrites only paths under the remote home", () => {
    expect(remapHome("/Users/a/p", "/Users/a", "/Users/b")).toBe("/Users/b/p");
    expect(remapHome("/Users/ab/p", "/Users/a", "/Users/b")).toBe("/Users/ab/p");
    expect(remapHome("/opt/p", "/Users/a", "/Users/b")).toBe("/opt/p");
  });

  test("isBytePrefix", () => {
    const a = join(root, "a");
    const b = join(root, "b");
    writeFileSync(a, "one\n");
    writeFileSync(b, "one\ntwo\n");
    expect(isBytePrefix(a, b)).toBe(true);
    expect(isBytePrefix(b, a)).toBe(false);
    writeFileSync(a, "uno\n");
    expect(isBytePrefix(a, b)).toBe(false);
  });
});

describe("share between two machines", () => {
  test("a session started on one machine is listed and resumable on the other", () => {
    const studio = machine("studio");
    const air = machine("air");
    startSession(studio, "s1", "Studio work", ["a", "b"]);

    const first = sync(studio);
    expect(first.exports.map((x) => x.cliSessionId)).toEqual(["s1"]);

    const plan = sync(air);
    expect(plan.imports).toHaveLength(1);
    expect(plan.imports[0]?.kind).toBe("new");
    expect(readFileSync(transcriptFile(air, "s1"), "utf8")).toBe("a\nb\n");
    const entry = JSON.parse(
      readFileSync(
        join(air.dataDir, "claude-code-sessions", ACCT, "env-1", "local_s1.json"),
        "utf8",
      ),
    );
    // Paths are rewritten from the studio's home to the air's.
    expect(entry.cwd).toBe(air.repo);
    expect(entry.gitAnchors[0].gitRoot).toBe(air.repo);
    expect(entry.title).toBe("Studio work");

    // Idempotent: nothing more to do on either side.
    expect(planShare(opts(air)).imports).toHaveLength(0);
    expect(planShare(opts(studio)).exports).toHaveLength(0);
  });

  test("continuing on the other machine flows back to the original", () => {
    const studio = machine("studio");
    const air = machine("air");
    startSession(studio, "s1", "Work", ["a"]);
    sync(studio);
    sync(air);

    // Continue on the air.
    const t = transcriptFile(air, "s1");
    appendFileSync(t, "b\n");
    utimesSync(t, OLD / 1000, OLD / 1000);
    const entryFile = join(air.dataDir, "claude-code-sessions", ACCT, "env-1", "local_s1.json");
    const e = JSON.parse(readFileSync(entryFile, "utf8"));
    writeFileSync(
      entryFile,
      JSON.stringify({ ...e, lastActivityAt: OLD + 1, title: "Work, continued" }),
    );
    sync(air);

    const plan = sync(studio);
    expect(plan.imports.map((x) => x.kind)).toEqual(["updated"]);
    expect(readFileSync(transcriptFile(studio, "s1"), "utf8")).toBe("a\nb\n");
    const back = JSON.parse(
      readFileSync(
        join(studio.dataDir, "claude-code-sessions", ACCT, "env-1", "local_s1.json"),
        "utf8",
      ),
    );
    expect(back.title).toBe("Work, continued");
    expect(back.cwd).toBe(studio.repo);
  });

  test("never overwrites a diverged, longer, or live local transcript", () => {
    const studio = machine("studio");
    const air = machine("air");
    startSession(studio, "s1", "Work", ["a"]);
    sync(studio);
    sync(air);

    // Both machines continue independently: diverged.
    appendFileSync(transcriptFile(studio, "s1"), "studio\n");
    utimesSync(transcriptFile(studio, "s1"), OLD / 1000, OLD / 1000);
    writeFileSync(transcriptFile(air, "s1"), "a\nair-longer-line\n");
    utimesSync(transcriptFile(air, "s1"), OLD / 1000, OLD / 1000);
    sync(air);
    const diverged = sync(studio);
    expect(diverged.skips.map((s) => s.reason)).toContain("diverged");
    expect(readFileSync(transcriptFile(studio, "s1"), "utf8")).toBe("a\nstudio\n");

    // A local transcript touched moments ago counts as live.
    writeFileSync(transcriptFile(studio, "s1"), "a\n");
    const live = planShare(opts(studio));
    expect(live.skips.map((s) => s.reason)).toContain("live-here");
  });

  test("skips sessions whose folder does not exist here", () => {
    const studio = machine("studio");
    const air = machine("air");
    startSession(studio, "s1", "Work", ["a"]);
    sync(studio);
    rmSync(air.repo, { recursive: true });
    const plan = planShare(opts(air));
    expect(plan.skips.map((s) => s.reason)).toEqual(["missing-cwd"]);
    expect(existsSync(transcriptFile(air, "s1"))).toBe(false);
  });

  test("old and archived sessions are not published", () => {
    const studio = machine("studio");
    startSession(studio, "s1", "Old", ["a"]);
    const f = join(studio.dataDir, "claude-code-sessions", ACCT, "env-1", "local_s1.json");
    const e = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...e, lastActivityAt: NOW - 30 * 86_400_000 }));
    startSession(studio, "s2", "Archived", ["a"]);
    const f2 = join(studio.dataDir, "claude-code-sessions", ACCT, "env-1", "local_s2.json");
    writeFileSync(
      f2,
      JSON.stringify({ ...JSON.parse(readFileSync(f2, "utf8")), isArchived: true }),
    );
    expect(planShare(opts(studio)).exports).toHaveLength(0);
  });

  test("sessions not downloaded yet are skipped, fetched, and imported next pass", () => {
    const studio = machine("studio");
    const air = machine("air");
    startSession(studio, "s1", "Ready", ["a"]);
    startSession(studio, "s2", "Still in the cloud", ["b"]);
    sync(studio);
    const cloudOnly = join(root, "share", "studio", "sessions", "s2", "transcript.jsonl");
    const requested: string[] = [];
    const first = planShare({
      ...opts(air),
      findPlaceholders: (paths) => new Set(paths.filter((p) => p === cloudOnly)),
      requestDownload: (paths) => requested.push(...paths),
    });
    expect(first.imports.map((x) => x.cliSessionId)).toEqual(["s1"]);
    expect(first.skips).toEqual([
      { machine: "studio", cliSessionId: "s2", title: null, reason: "not-downloaded" },
    ]);
    expect(requested).toEqual([join(root, "share", "studio", "sessions", "s2")]);

    const second = planShare({ ...opts(air), findPlaceholders: () => new Set() });
    expect(second.imports.map((x) => x.cliSessionId).sort()).toEqual(["s1", "s2"]);
  });

  test("a session that fails to copy is reported and the rest still import", () => {
    const studio = machine("studio");
    const air = machine("air");
    startSession(studio, "s1", "Broken", ["a"]);
    startSession(studio, "s2", "Fine", ["b"]);
    sync(studio);
    const plan = planShare({ ...opts(air), findPlaceholders: () => new Set() });
    const broken = plan.imports.find((x) => x.cliSessionId === "s1");
    if (!broken) throw new Error("s1 not planned");
    broken.transcriptFrom = join(root, "share", "studio", "sessions", "s1", "gone.jsonl");
    const result = applyShare(plan, { ...opts(air), findPlaceholders: () => new Set() });
    expect(result.imported).toBe(1);
    expect(result.failed.map((f) => f.cliSessionId)).toEqual(["s1"]);
    expect(existsSync(transcriptFile(air, "s2"))).toBe(true);
    expect(existsSync(`${transcriptFile(air, "s1")}.harnery-tmp`)).toBe(false);
  });
});
