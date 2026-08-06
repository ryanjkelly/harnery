/**
 * Regression: the hook and the CLI must resolve the SAME coordination root.
 *
 * They did not. With a shell inside a submodule that carries its own
 * `.harnery/`, the Stop hook read the submodule's stream (it walks up from
 * `CLAUDE_PROJECT_DIR`/cwd) while the CLI asked git for the superproject first,
 * so `agents status` emitted `state.status_checked` into a file the hook never
 * opened. Rule 1/3 filters events by `instance_id` within one stream, so a
 * correctly-scoped event in the wrong FILE is invisible: every turn blocked,
 * and no sequence of CLI commands could satisfy it.
 *
 * The load-bearing assertion is the end-to-end one — a real `harn agents status`
 * run, cwd inside the submodule, with no root override to help it, must leave
 * behind an event that `evaluateStopHook` accepts for that same session.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCoordRoot } from "../../src/core/agents/coord-client.ts";
import { evaluateStopHook } from "../../src/core/agents/rules/stop-hook.ts";

const HARN = resolve(import.meta.dir, "..", "..", "bin", "harn");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  /** Stands in for the superproject: carries `.harnery/`. */
  outer: string;
  /** Stands in for a submodule that carries its own `.harnery/`. */
  nested: string;
  session: string;
}

/** Two nested coordination roots, neither seeded with a session yet. */
function makeFixture(): Fixture {
  const outer = mkdtempSync(join(tmpdir(), "coord-agree-"));
  dirs.push(outer);
  const nested = join(outer, "submodule");
  for (const root of [outer, nested]) {
    mkdirSync(join(root, ".harnery", "active"), { recursive: true });
    mkdirSync(join(root, ".harnery", "pid-map"), { recursive: true });
  }
  return { outer, nested, session: "sess-coord-agree-1" };
}

/** Register a live session in one root, the way the hook's session.start does. */
function seedSession(root: string, session: string): void {
  writeFileSync(
    join(root, ".harnery", "active", `${session}.json`),
    JSON.stringify({
      instance_id: session,
      session_id: session,
      agent_id: session,
      kind: "session",
      platform: "claude-code",
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      files_touched: [],
    }),
  );
}

/**
 * Environment for a child that must resolve the root unaided: the suite's own
 * coordination env would otherwise pin, name, or misidentify the session.
 */
function bareEnv(session: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.HARNERY_COORD_ROOT_OVERRIDE;
  delete env.HARNERY_AGENT_COORD_OWNER;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CURSOR_SESSION_ID;
  delete env.CURSOR_CONVERSATION_ID;
  delete env.CODEX_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  env.CLAUDE_CODE_SESSION_ID = session;
  env.HARNERY_AGENT_COORD_SESSION_ID = session;
  env.HARNERY_OUTPUT_SESSION_TEE = "0";
  return env;
}

function streamPath(root: string): string {
  return join(root, ".harnery", "events.ndjson");
}

function readStatusCheckedIds(root: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(streamPath(root), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l))
    .filter((e) => e.event_type === "state.status_checked")
    .map((e) => e.instance_id as string);
}

/**
 * Seed the turn boundary rule 1/3 measures against: a prompt to open the turn
 * and a tool call, since a turn with no tool calls takes the pure-prose
 * exemption and would pass without proving anything.
 */
function seedTurn(root: string, session: string): void {
  const base = {
    schema_version: 1,
    session_id: session,
    instance_id: session,
    adapter: "cursor",
    source: "agent-hooks",
  };
  const lines = [
    { ...base, event_id: "01TURNOPEN", event_type: "user_prompt.submit", ts: iso(-60), data: {} },
    { ...base, event_id: "01TOOLCALL", event_type: "tool.pre_use", ts: iso(-30), data: {} },
  ];
  appendFileSync(streamPath(root), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

function iso(secondsFromNow: number): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

describe("resolveCoordRoot: one root for the hook and the CLI", () => {
  const saved = {
    override: process.env.HARNERY_COORD_ROOT_OVERRIDE,
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    session: process.env.HARNERY_AGENT_COORD_SESSION_ID,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["HARNERY_COORD_ROOT_OVERRIDE", saved.override],
      ["CLAUDE_PROJECT_DIR", saved.projectDir],
      ["HARNERY_AGENT_COORD_SESSION_ID", saved.session],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("session registered in the submodule → the submodule root (this bug)", () => {
    const { nested, session } = makeFixture();
    seedSession(nested, session);
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;

    expect(resolveCoordRoot(nested)).toBe(nested);
  });

  test("session registered in the outer root → the outer root, from the same cwd", () => {
    // The opposite direction, and the reason neither root can simply win:
    // the adapter opened the superproject and the shell cd'd into a submodule
    // that happens to carry its own `.harnery/` (see
    // coord-helper-root-pin.test.ts). Walking up from cwd would strand this
    // session in a root that has never heard of it.
    const { outer, nested, session } = makeFixture();
    seedSession(outer, session);
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;

    expect(resolveCoordRoot(nested)).toBe(outer);
  });

  test("no root knows the session → nearest enclosing .harnery/", () => {
    const { nested, session } = makeFixture();
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session; // registered nowhere
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;

    expect(resolveCoordRoot(nested)).toBe(nested);
  });

  test("a stale heartbeat does not claim the session", () => {
    const { outer, nested, session } = makeFixture();
    seedSession(outer, session);
    writeFileSync(
      join(nested, ".harnery", "active", `${session}.json`),
      JSON.stringify({
        instance_id: session,
        session_id: session,
        last_heartbeat: iso(-60 * 60),
      }),
    );
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;

    expect(resolveCoordRoot(nested)).toBe(outer);
  });

  test("CLAUDE_PROJECT_DIR and the explicit override still take precedence", () => {
    const { outer, nested, session } = makeFixture();
    seedSession(nested, session);
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session;

    process.env.CLAUDE_PROJECT_DIR = outer;
    expect(resolveCoordRoot(nested)).toBe(outer);

    process.env.HARNERY_COORD_ROOT_OVERRIDE = nested;
    expect(resolveCoordRoot(outer)).toBe(nested);
  });
});

describe("`harn agents status` satisfies rule 1/3 from inside a submodule", () => {
  test("the event lands in the stream the hook reads, and the verdict clears", () => {
    const { outer, nested, session } = makeFixture();
    seedSession(nested, session);
    seedTurn(nested, session);

    // No HARNERY_COORD_ROOT_OVERRIDE: resolving the root unaided is the thing
    // under test. cwd is the submodule, as an agent's shell would be.
    // The whole ritual runs, not just status: `set-task` (rule 3/3) resolves
    // and emits over the same path, so a root split shows up here too.
    const setTask = spawnSync(HARN, ["agents", "set-task", "coord root agreement"], {
      cwd: nested,
      encoding: "utf8",
      env: bareEnv(session),
      timeout: 30_000,
    });
    expect(setTask.status).toBe(0);

    const run = spawnSync(HARN, ["agents", "status"], {
      cwd: nested,
      encoding: "utf8",
      env: bareEnv(session),
      timeout: 30_000,
    });
    expect(run.status).toBe(0);

    // The hook's stream gained the event, keyed to the session the hook sees.
    expect(readStatusCheckedIds(nested)).toContain(session);
    // ...and the neighbouring root did not silently receive it instead.
    expect(readStatusCheckedIds(outer)).not.toContain(session);

    // The verdict the Stop hook would reach, over the root it resolves.
    const verdict = evaluateStopHook(nested, {
      rule: "stop-hook",
      instance_id: session,
      session_id: session,
      adapter: "cursor", // ack signal is status_checked; no transcript needed
    });
    expect(verdict.rule).not.toBe("stop-hook.rule_1_3");
    expect(verdict.allow).toBe(true);
  });

  test("the same events under the neighbouring root would NOT clear rule 1/3", () => {
    // Teeth for the test above: proves the assertion is about WHICH file the
    // event reached, not merely that some event was written somewhere.
    const { outer, nested, session } = makeFixture();
    seedSession(nested, session);
    seedTurn(nested, session);
    seedTurn(outer, session);

    const run = spawnSync(HARN, ["agents", "status"], {
      cwd: nested,
      encoding: "utf8",
      env: bareEnv(session),
      timeout: 30_000,
    });
    expect(run.status).toBe(0);

    const verdict = evaluateStopHook(outer, {
      rule: "stop-hook",
      instance_id: session,
      session_id: session,
      adapter: "cursor",
    });
    expect(verdict.rule).toBe("stop-hook.rule_1_3");
  });
});
