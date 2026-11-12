import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHelperUsage,
  HELPER_USAGE_RETENTION_DAYS,
  type HelperUsageLine,
  helperUsageDir,
  helperUsageFile,
  summarizeHelperUsage,
} from "./helper-usage.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harnery-helper-usage-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-11-11T12:00:00.000Z");

function line(overrides: Partial<HelperUsageLine> = {}): HelperUsageLine {
  return {
    ts: "2026-11-11T10:00:00.000Z",
    tool: "claude-code",
    kind: "helper",
    lowered: false,
    ...overrides,
  };
}

function writeDay(day: string, lines: (HelperUsageLine | string)[]): void {
  const body = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n");
  writeFileSync(join(dir, `usage-${day}.jsonl`), `${body}\n`);
}

describe("summarizeHelperUsage", () => {
  test("an empty directory reads as zeros", () => {
    const since = new Date("2026-11-10T12:00:00.000Z");
    expect(summarizeHelperUsage(since, { dir, now: NOW })).toEqual({
      since: since.toISOString(),
      helpers: 0,
      lowered: 0,
      by_model: {},
    });
  });

  test("a missing directory reads as zeros without creating it", () => {
    const missing = join(dir, "nope");
    const result = summarizeHelperUsage(new Date("2026-11-10T00:00:00Z"), {
      dir: missing,
      now: NOW,
    });
    expect(result.helpers).toBe(0);
    expect(result.by_model).toEqual({});
    expect(existsSync(missing)).toBe(false);
  });

  test("round trips lines written by appendHelperUsage", () => {
    appendHelperUsage(line({ session_id: "s1", agent_id: "a1", sent_model: "sonnet" }), dir);
    appendHelperUsage(
      line({ session_id: "s1", agent_id: "a2", answered_model: "claude-haiku-4", lowered: true }),
      dir,
    );
    expect(readdirSync(dir)).toEqual(["usage-2026-11-11.jsonl"]);
    const result = summarizeHelperUsage(new Date("2026-11-11T00:00:00Z"), { dir, now: NOW });
    expect(result).toEqual({
      since: "2026-11-11T00:00:00.000Z",
      helpers: 2,
      lowered: 1,
      by_model: { sonnet: 1, "claude-haiku-4": 1 },
    });
  });

  test("the since boundary is inclusive within a day", () => {
    writeDay("2026-11-11", [
      line({ ts: "2026-11-11T08:59:59.999Z", sent_model: "early" }),
      line({ ts: "2026-11-11T09:00:00.000Z", sent_model: "edge" }),
      line({ ts: "2026-11-11T11:00:00.000Z", sent_model: "late" }),
    ]);
    const result = summarizeHelperUsage(new Date("2026-11-11T09:00:00.000Z"), { dir, now: NOW });
    expect(result.helpers).toBe(2);
    expect(result.by_model).toEqual({ edge: 1, late: 1 });
  });

  test("the since boundary crosses UTC midnight", () => {
    writeDay("2026-11-09", [line({ ts: "2026-11-09T23:00:00.000Z", sent_model: "too-old" })]);
    writeDay("2026-11-10", [
      line({ ts: "2026-11-10T11:59:00.000Z", sent_model: "before" }),
      line({ ts: "2026-11-10T23:30:00.000Z", sent_model: "yesterday" }),
    ]);
    writeDay("2026-11-11", [line({ ts: "2026-11-11T00:30:00.000Z", sent_model: "today" })]);
    const result = summarizeHelperUsage(new Date("2026-11-10T12:00:00.000Z"), { dir, now: NOW });
    expect(result.by_model).toEqual({ yesterday: 1, today: 1 });
  });

  test("per-writer files for a day are read alongside the shared file", () => {
    const line = (agent: string) =>
      `${JSON.stringify({ ts: "2026-03-05T10:00:00.000Z", tool: "claude-code", kind: "helper", session_id: "s1", agent_id: agent, sent_model: "opus", lowered: true })}\n`;
    writeFileSync(join(dir, "usage-2026-03-05.jsonl"), line("a1"));
    writeFileSync(join(dir, "usage-2026-03-05.session-abc_1.jsonl"), line("a2"));
    writeFileSync(join(dir, "usage-2026-03-05.bad name.jsonl"), line("a3"));
    const summary = summarizeHelperUsage(new Date("2026-03-05T00:00:00.000Z"), {
      dir,
      now: new Date("2026-03-05T12:00:00.000Z"),
    });
    expect(summary.helpers).toBe(2);
    expect(summary.lowered).toBe(2);
  });

  test("repeated turns of one helper count once, under its latest model", () => {
    writeDay("2026-11-10", [
      line({ ts: "2026-11-10T22:00:00Z", session_id: "s", agent_id: "a", answered_model: "opus" }),
    ]);
    writeDay("2026-11-11", [
      line({
        ts: "2026-11-11T02:00:00Z",
        session_id: "s",
        agent_id: "a",
        answered_model: "sonnet",
      }),
      line({ ts: "2026-11-11T01:00:00Z", session_id: "s", agent_id: "a", answered_model: "haiku" }),
      line({ ts: "2026-11-11T03:00:00Z", session_id: "s", agent_id: "b", answered_model: "opus" }),
      line({ ts: "2026-11-11T03:00:00Z", session_id: "t", agent_id: "a", answered_model: "opus" }),
    ]);
    const result = summarizeHelperUsage(new Date("2026-11-10T00:00:00Z"), { dir, now: NOW });
    expect(result.helpers).toBe(3);
    expect(result.by_model).toEqual({ sonnet: 1, opus: 2 });
  });

  test("lines missing either id each count as their own helper, run workers included", () => {
    writeDay("2026-11-11", [
      line({ session_id: "s" }),
      line({ session_id: "s" }),
      line({ agent_id: "a" }),
      line({ kind: "run-worker" }),
      line({ kind: "run-worker" }),
    ]);
    const result = summarizeHelperUsage(new Date("2026-11-11T00:00:00Z"), { dir, now: NOW });
    expect(result.helpers).toBe(5);
    expect(result.by_model).toEqual({ unknown: 5 });
  });

  test("lowered counts distinct helpers with any lowered line", () => {
    writeDay("2026-11-11", [
      line({ ts: "2026-11-11T01:00:00Z", session_id: "s", agent_id: "a", lowered: true }),
      line({ ts: "2026-11-11T02:00:00Z", session_id: "s", agent_id: "a", lowered: false }),
      line({ ts: "2026-11-11T03:00:00Z", session_id: "s", agent_id: "a", lowered: true }),
      line({ ts: "2026-11-11T01:00:00Z", session_id: "s", agent_id: "b", lowered: false }),
      line({ ts: "2026-11-11T01:00:00Z", kind: "run-worker", lowered: true }),
    ]);
    const result = summarizeHelperUsage(new Date("2026-11-11T00:00:00Z"), { dir, now: NOW });
    expect(result.helpers).toBe(3);
    expect(result.lowered).toBe(2);
  });

  test("by_model prefers answered, then sent, then asked, then unknown", () => {
    writeDay("2026-11-11", [
      line({ asked_model: "opus", sent_model: "sonnet", answered_model: "claude-sonnet-5-5" }),
      line({ asked_model: "opus", sent_model: "sonnet" }),
      line({ asked_model: "opus" }),
      line({}),
    ]);
    const result = summarizeHelperUsage(new Date("2026-11-11T00:00:00Z"), { dir, now: NOW });
    expect(result.by_model).toEqual({ "claude-sonnet-5-5": 1, sonnet: 1, opus: 1, unknown: 1 });
  });

  test("the family option groups model ids and keeps ids it cannot name", () => {
    writeDay("2026-11-11", [
      line({ answered_model: "claude-opus-5-5" }),
      line({ answered_model: "claude-opus-4-1" }),
      line({ sent_model: "opus" }),
      line({ answered_model: "mystery-model" }),
      line({}),
    ]);
    const family = (model: string): string | null =>
      ["haiku", "sonnet", "opus", "fable"].find((name) => model.includes(name)) ?? null;
    const result = summarizeHelperUsage(new Date("2026-11-11T00:00:00Z"), {
      dir,
      now: NOW,
      family,
    });
    expect(result.by_model).toEqual({ opus: 3, "mystery-model": 1, unknown: 1 });
  });

  test("the tool filter keeps only matching lines", () => {
    writeDay("2026-11-11", [
      line({ tool: "claude-code", sent_model: "sonnet" }),
      line({ tool: "codex", sent_model: "gpt" }),
      line({ tool: "codex", sent_model: "gpt" }),
    ]);
    const since = new Date("2026-11-11T00:00:00Z");
    expect(summarizeHelperUsage(since, { dir, now: NOW, tool: "codex" }).by_model).toEqual({
      gpt: 2,
    });
    expect(summarizeHelperUsage(since, { dir, now: NOW, tool: "cursor" }).helpers).toBe(0);
    expect(summarizeHelperUsage(since, { dir, now: NOW }).helpers).toBe(3);
  });

  test("malformed, blank and non-object lines are skipped", () => {
    writeDay("2026-11-11", [
      "",
      "   ",
      "{not json",
      "42",
      "null",
      "[1,2]",
      JSON.stringify({ tool: "claude-code" }),
      JSON.stringify({ ts: "not a date", tool: "claude-code" }),
      line({ sent_model: "sonnet" }),
    ]);
    const result = summarizeHelperUsage(new Date("2026-11-11T00:00:00Z"), { dir, now: NOW });
    expect(result.helpers).toBe(1);
    expect(result.by_model).toEqual({ sonnet: 1 });
  });

  test("an unreadable usage file is skipped", () => {
    mkdirSync(join(dir, "usage-2026-11-10.jsonl"));
    writeDay("2026-11-11", [line({ sent_model: "sonnet" })]);
    const result = summarizeHelperUsage(new Date("2026-11-10T00:00:00Z"), { dir, now: NOW });
    expect(result.helpers).toBe(1);
  });

  test("retention removes only old usage files", () => {
    expect(HELPER_USAGE_RETENTION_DAYS).toBe(7);
    writeDay("2026-10-01", [line({ ts: "2026-10-01T00:00:00Z" })]);
    writeDay("2026-11-03", [line({ ts: "2026-11-03T00:00:00Z" })]);
    writeDay("2026-11-04", [line({ ts: "2026-11-04T00:00:00Z" })]);
    writeDay("2026-11-11", [line()]);
    writeFileSync(join(dir, "notes.txt"), "keep\n");
    writeFileSync(join(dir, "usage-2026-10-01.json"), "keep\n");
    writeFileSync(join(dir, "other-2026-10-01.jsonl"), "keep\n");
    const result = summarizeHelperUsage(new Date("2026-11-11T00:00:00Z"), { dir, now: NOW });
    expect(result.helpers).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([
      "notes.txt",
      "other-2026-10-01.jsonl",
      "usage-2026-10-01.json",
      "usage-2026-11-04.jsonl",
      "usage-2026-11-11.jsonl",
    ]);
  });

  test("retention runs even when since is older than the kept window", () => {
    writeDay("2026-10-01", [line({ ts: "2026-10-01T00:00:00Z" })]);
    writeDay("2026-11-10", [line({ ts: "2026-11-10T00:00:00Z" })]);
    const result = summarizeHelperUsage(new Date("2026-09-01T00:00:00Z"), { dir, now: NOW });
    expect(result.helpers).toBe(1);
    expect(readdirSync(dir)).toEqual(["usage-2026-11-10.jsonl"]);
  });
});

describe("helperUsageDir", () => {
  const saved = process.env.XDG_CACHE_HOME;
  afterEach(() => {
    if (saved === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved;
  });

  test("honors XDG_CACHE_HOME", () => {
    process.env.XDG_CACHE_HOME = join(dir, "xdg");
    expect(helperUsageDir()).toBe(join(dir, "xdg", "harnery", "helpers"));
  });

  test("falls back to ~/.cache when XDG_CACHE_HOME is blank", () => {
    process.env.XDG_CACHE_HOME = "  ";
    expect(helperUsageDir().endsWith(join(".cache", "harnery", "helpers"))).toBe(true);
  });

  test("names files by UTC day", () => {
    expect(helperUsageFile("2026-11-11T23:59:59.000Z", dir)).toBe(
      join(dir, "usage-2026-11-11.jsonl"),
    );
  });
});

describe("appendHelperUsage", () => {
  test("never throws when the directory cannot be created", () => {
    const blocker = join(dir, "file");
    writeFileSync(blocker, "x");
    expect(() => appendHelperUsage(line(), join(blocker, "helpers"))).not.toThrow();
    expect(existsSync(join(blocker, "helpers"))).toBe(false);
  });
});
