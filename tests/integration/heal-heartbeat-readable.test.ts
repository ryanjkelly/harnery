/**
 * Locks the heal → read round-trip: a heartbeat created by `harn agents heal
 * --kind heartbeat` must be resolvable by the commands that read one
 * (`agents status`, `agents set-task`).
 *
 * Why this is an integration test rather than a writer unit test: the bug it
 * guards lived in the SEAM, not in either side. Heartbeats are keyed by the
 * whole instance_id (`.harnery/active/<instance_id>.json`), and every writer
 * already agreed on that. What broke was the id a reader handed back: the
 * `no_heartbeat` diagnostic abbreviated the owner to 8 chars with no ellipsis,
 * so it read as a complete id, got copy-pasted into `heal --owner`, and minted
 * `.harnery/active/<prefix>.json` — a file no reader resolves. Heal reported
 * "heartbeat_present", `set-task` kept failing with `no heartbeat at
 * <full-id>.json`, and the session looked unhealable while an orphan
 * accumulated in the active dir (where the single-live-agent fallback of
 * ADR 0004 can then mis-resolve unrelated callers to it).
 *
 * Only an assertion that spans both binaries catches that. Each side passes its
 * own tests in isolation.
 *
 * Mechanics: a fresh mkdtemp coord-root per test, git-init'd so path
 * canonicalization resolves, and HARNERY_COORD_ROOT_OVERRIDE pinning all state
 * into the sandbox.
 *
 * Deliberately NO `<root>/harnery` symlink. An earlier draft created one because
 * the coord layer built its helper path as
 * `join(coordRoot, "harnery", "bin", "agent-coord")` — an assumption that only
 * holds when the root is a superproject carrying harnery as a submodule. The
 * helper is now resolved from harnery's own package location, so the symlink is
 * unnecessary; leaving it in would let that assumption come back unnoticed,
 * since the sandbox would satisfy it either way.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HARNERY_DIR = path.resolve(import.meta.dir, "../..");
const HARN = path.join(HARNERY_DIR, "bin", "harn");

/** A full adapter session id, and the 8-char prefix a truncating diagnostic
 * would have printed for it. */
const SESSION_ID = "45f21628-043a-463d-a394-4128789f2276";
const TRUNCATED = SESSION_ID.slice(0, 8);

const sandboxes: string[] = [];

function makeSandbox(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-healread-"));
  sandboxes.push(root);
  mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
  mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  git(["commit", "-q", "--allow-empty", "-m", "seed"]);
  return root;
}

afterEach(() => {
  while (sandboxes.length) {
    const root = sandboxes.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function harn(root: string, args: string[]): RunResult {
  const r = spawnSync("bash", [HARN, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

/** Parse the JSON envelope a `--json` invocation writes, from whichever stream
 * carried it (errors and data envelopes do not share a stream). */
function envelope(res: RunResult): Record<string, unknown> {
  const raw = `${res.stdout}\n${res.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .pop();
  if (!raw) throw new Error(`no JSON envelope in output:\n${res.stdout}\n${res.stderr}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

function activeFiles(root: string): string[] {
  const dir = path.join(root, ".harnery", "active");
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
    : [];
}

function heartbeat(root: string, owner: string): Record<string, unknown> {
  const p = path.join(root, ".harnery", "active", `${owner}.json`);
  return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
}

describe("heal → read round-trip", () => {
  test("a healed heartbeat is readable by status and set-task", () => {
    const root = makeSandbox();

    // Precondition: the session is unregistered, exactly as it is when the
    // SessionStart hook never ran.
    expect(activeFiles(root)).toEqual([]);

    const healed = harn(root, [
      "agents",
      "heal",
      "--kind",
      "heartbeat",
      "--owner",
      SESSION_ID,
      "--session-id",
      SESSION_ID,
      "--json",
    ]);
    expect(healed.status).toBe(0);
    expect((envelope(healed).rows as Array<Record<string, unknown>>)[0].outcome).toBe(
      "heartbeat_present",
    );

    // Keyed by the whole instance_id — this filename is the contract the
    // readers below depend on.
    expect(activeFiles(root)).toEqual([`${SESSION_ID}.json`]);

    // The assertion that would have caught the original bug: the readers
    // resolve what heal just wrote. Before the fix, both of these still failed
    // with `no heartbeat at .harnery/active/<full-id>.json` after a heal that
    // reported success.
    const status = harn(root, ["agents", "status", "--session-id", SESSION_ID, "--json"]);
    expect(status.status).toBe(0);
    expect(envelope(status).error).toBeUndefined();
    expect(envelope(status).instance_id).toBe(SESSION_ID);

    const setTask = harn(root, ["agents", "set-task", "healed-ok", "--session-id", SESSION_ID]);
    expect(setTask.status).toBe(0);

    // set-task landed on the healed heartbeat, not a second file.
    expect(activeFiles(root)).toEqual([`${SESSION_ID}.json`]);
    expect(heartbeat(root, SESSION_ID).task).toBe("healed-ok");
  });

  test("heal refuses a truncated owner id instead of minting an orphan", () => {
    const root = makeSandbox();

    const res = harn(root, [
      "agents",
      "heal",
      "--kind",
      "heartbeat",
      "--owner",
      TRUNCATED,
      "--session-id",
      SESSION_ID,
      "--json",
    ]);

    expect(res.status).not.toBe(0);
    const err = envelope(res).error as Record<string, unknown>;
    expect(err.code).toBe("truncated_owner");
    // The refusal names the id to retry with, so the fix is one copy-paste.
    expect(String(err.message)).toContain(SESSION_ID);

    // Nothing was written: no orphan for the singleton fallback to find.
    expect(activeFiles(root)).toEqual([]);
  });

  test("an existing heartbeat at a short owner id still heals", () => {
    const root = makeSandbox();

    // The guard covers the CREATE path only. A short-but-real instance_id
    // (subagents and workflow children carry their own, distinct from the
    // parent session_id) must stay healable once its heartbeat exists.
    const seed = harn(root, [
      "agents",
      "heal",
      "--kind",
      "heartbeat",
      "--owner",
      TRUNCATED,
      "--session-id",
      TRUNCATED,
      "--json",
    ]);
    expect(seed.status).toBe(0);
    expect(activeFiles(root)).toEqual([`${TRUNCATED}.json`]);

    const again = harn(root, [
      "agents",
      "heal",
      "--kind",
      "heartbeat",
      "--owner",
      TRUNCATED,
      "--session-id",
      SESSION_ID,
      "--json",
    ]);
    expect(again.status).toBe(0);
    expect((envelope(again).rows as Array<Record<string, unknown>>)[0].outcome).toBe(
      "heartbeat_present",
    );
  });

  test("heal refuses a truncated owner even with no --session-id to compare against", () => {
    // The reported path, and the one the first version of this guard missed:
    // the id is copied out of a diagnostic and passed as --owner alone. There is
    // no --session-id to prove it truncated, but the live heartbeat it prefixes
    // is right there in the same active dir.
    const root = makeSandbox();
    const seeded = harn(root, [
      "agents",
      "heal",
      "--kind",
      "heartbeat",
      "--owner",
      SESSION_ID,
      "--session-id",
      SESSION_ID,
      "--json",
    ]);
    expect(seeded.status).toBe(0);

    const res = harn(root, [
      "agents",
      "heal",
      "--kind",
      "heartbeat",
      "--owner",
      TRUNCATED,
      "--json",
    ]);

    expect(res.status).not.toBe(0);
    expect((envelope(res).error as Record<string, unknown>).code).toBe("truncated_owner");
    // No orphan beside the real heartbeat.
    expect(activeFiles(root)).toEqual([`${SESSION_ID}.json`]);
  });

  test("an unrelated short owner still heals when no live id shadows it", () => {
    // The guard must not become "short ids are illegal": with nothing for the
    // prefix to shadow, a short instance_id is just an instance_id.
    const root = makeSandbox();
    const res = harn(root, [
      "agents",
      "heal",
      "--kind",
      "heartbeat",
      "--owner",
      "sess-tiny",
      "--json",
    ]);
    expect(res.status).toBe(0);
    expect(activeFiles(root)).toEqual(["sess-tiny.json"]);
  });

  test("the no_heartbeat diagnostic quotes the owner id in full", () => {
    const root = makeSandbox();

    // This message is the sole source of the id the reader feeds back into
    // `heal --owner`, so it has to carry the whole thing. An 8-char prefix
    // printed without an ellipsis is what started the orphan chain.
    //
    // Asserted unconditionally: an earlier version skipped whenever the error
    // was absent or carried another code, which let the whole test pass while
    // checking nothing.
    const res = harn(root, ["agents", "status", "--session-id", SESSION_ID, "--json"]);
    expect(res.status).not.toBe(0);
    const err = envelope(res).error as Record<string, unknown>;
    expect(err.code).toBe("no_heartbeat");
    const message = String(err.message);
    expect(message).toContain(SESSION_ID);
    // Guard against a regression to the bare prefix form.
    expect(message).not.toMatch(new RegExp(`owner=${TRUNCATED}(?![0-9a-f-])`));
  });
});
