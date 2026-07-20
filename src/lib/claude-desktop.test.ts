import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMirror,
  entryMatchesSelector,
  findDesktopDataDirs,
  listAccounts,
  planMirror,
} from "./claude-desktop.ts";

const ACCT_A = "aaaaaaaa-0000-0000-0000-000000000001";
const ACCT_B = "bbbbbbbb-0000-0000-0000-000000000002";
const ENV = "eeeeeeee-0000-0000-0000-00000000000e";

let dataDir: string;

function writeEntry(account: string, localId: string, fields: Record<string, unknown>): string {
  const dir = join(dataDir, "claude-code-sessions", account, ENV);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `local_${localId}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      sessionId: `local_${localId}`,
      cliSessionId: `cli-${localId}`,
      cwd: "/home/user/project",
      title: `Session ${localId}`,
      model: "claude-fable-5",
      isArchived: false,
      createdAt: 1000,
      lastActivityAt: 2000,
      ...fields,
    }),
  );
  return file;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "harn-claude-desktop-"));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("findDesktopDataDirs", () => {
  test("returns explicit dir only when it has a sessions index", () => {
    expect(findDesktopDataDirs(dataDir)).toEqual([]);
    writeEntry(ACCT_A, "one", {});
    expect(findDesktopDataDirs(dataDir)).toEqual([dataDir]);
  });
});

describe("listAccounts", () => {
  test("enumerates accounts + entries, newest activity first", () => {
    writeEntry(ACCT_A, "old", { lastActivityAt: 100 });
    writeEntry(ACCT_A, "new", { lastActivityAt: 900 });
    writeEntry(ACCT_B, "solo", { lastActivityAt: 500 });
    const accounts = listAccounts(dataDir);
    expect(accounts).toHaveLength(2);
    const a = accounts.find((x) => x.accountUuid === ACCT_A);
    expect(a?.entries.map((e) => e.cliSessionId)).toEqual(["cli-new", "cli-old"]);
    expect(a?.entries[0]?.envId).toBe(ENV);
    // account order: newest activity first (A has 900 > B's 500)
    expect(accounts[0]?.accountUuid).toBe(ACCT_A);
  });

  test("tolerates malformed JSON files", () => {
    writeEntry(ACCT_A, "good", {});
    const dir = join(dataDir, "claude-code-sessions", ACCT_A, ENV);
    writeFileSync(join(dir, "local_bad.json"), "{nope");
    const accounts = listAccounts(dataDir);
    expect(accounts[0]?.entries).toHaveLength(1);
  });
});

describe("planMirror + applyMirror", () => {
  test("plans copies for entries the target lacks, applies them, and is idempotent", () => {
    writeEntry(ACCT_A, "one", {});
    writeEntry(ACCT_A, "two", {});
    writeEntry(ACCT_B, "three", {});
    const plan = planMirror(listAccounts(dataDir));
    // A gets B's entry; B gets A's two entries
    expect(plan.actions).toHaveLength(3);
    expect(applyMirror(plan)).toEqual({ copied: 3 });
    expect(existsSync(join(dataDir, "claude-code-sessions", ACCT_B, ENV, "local_one.json"))).toBe(
      true,
    );
    // second pass: nothing left to do
    const again = planMirror(listAccounts(dataDir));
    expect(again.actions).toHaveLength(0);
    expect(again.skippedExisting).toBeGreaterThan(0);
  });

  test("dedups by cliSessionId even when filenames differ", () => {
    writeEntry(ACCT_A, "x1", { cliSessionId: "cli-shared" });
    writeEntry(ACCT_B, "x2", { cliSessionId: "cli-shared" });
    const plan = planMirror(listAccounts(dataDir));
    expect(plan.actions).toHaveLength(0);
    expect(plan.skippedExisting).toBe(2);
  });

  test("skips archived entries unless includeArchived", () => {
    writeEntry(ACCT_A, "arch", { isArchived: true });
    writeEntry(ACCT_B, "live", {});
    const without = planMirror(listAccounts(dataDir));
    expect(without.actions.map((a) => a.entry.cliSessionId)).toEqual(["cli-live"]);
    expect(without.skippedArchived).toBe(1);
    const withArchived = planMirror(listAccounts(dataDir), { includeArchived: true });
    expect(withArchived.actions).toHaveLength(2);
  });

  test("session selectors match id exactly and title as substring", () => {
    writeEntry(ACCT_A, "one", { title: "Agent Yann - Shopify Theme v2" });
    writeEntry(ACCT_A, "two", { title: "Agent Beatrice - Rebuy Data Extraction" });
    // an empty second account to mirror into
    mkdirSync(join(dataDir, "claude-code-sessions", ACCT_B), { recursive: true });
    const byId = planMirror(listAccounts(dataDir), { sessions: ["cli-one"] });
    expect(byId.actions.map((a) => a.entry.cliSessionId)).toEqual(["cli-one"]);
    const byTitle = planMirror(listAccounts(dataDir), { sessions: ["rebuy data"] });
    expect(byTitle.actions.map((a) => a.entry.cliSessionId)).toEqual(["cli-two"]);
  });

  test("to/from prefixes restrict direction", () => {
    writeEntry(ACCT_A, "one", {});
    writeEntry(ACCT_B, "two", {});
    const onlyIntoB = planMirror(listAccounts(dataDir), { to: ["bbbbbbbb"] });
    expect(onlyIntoB.actions).toHaveLength(1);
    expect(onlyIntoB.actions[0]?.targetAccountUuid).toBe(ACCT_B);
    const onlyFromB = planMirror(listAccounts(dataDir), { from: ["bbbbbbbb"] });
    expect(onlyFromB.actions).toHaveLength(1);
    expect(onlyFromB.actions[0]?.entry.cliSessionId).toBe("cli-two");
  });
});

describe("entryMatchesSelector", () => {
  test("matches sessionId, cliSessionId, and case-insensitive title substring", () => {
    const [account] = listAccounts(
      (writeEntry(ACCT_A, "sel", { title: "My Great Session" }), dataDir),
    );
    const entry = account?.entries[0];
    if (!entry) throw new Error("fixture entry missing");
    expect(entryMatchesSelector(entry, "cli-sel")).toBe(true);
    expect(entryMatchesSelector(entry, "local_sel")).toBe(true);
    expect(entryMatchesSelector(entry, "great sess")).toBe(true);
    expect(entryMatchesSelector(entry, "nope")).toBe(false);
  });
});
