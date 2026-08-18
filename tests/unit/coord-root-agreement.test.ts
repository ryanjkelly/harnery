/**
 * Regression: the hook and the CLI must resolve the SAME coordination root.
 *
 * A shell inside a submodule may encounter two coordination roots. Resolution
 * must follow the registered session unless an explicit root wins.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCoordRoot } from "../../src/core/agents/coord-client.ts";
import { initializeV2Fixture, seedV2Session } from "../helpers/event-v2.ts";

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
    initializeV2Fixture(root);
  }
  return { outer, nested, session: "sess-coord-agree-1" };
}

/** Register a live session through the canonical V2 hook producer. */
function seedSession(root: string, session: string): void {
  seedV2Session(root, session, { sessionId: session, adapter: "claude-code" });
}

describe("resolveCoordRoot: one root for the hook and the CLI", () => {
  const saved = {
    override: process.env.HARNERY_COORD_ROOT_OVERRIDE,
    projectDir: process.env.CLAUDE_PROJECT_DIR,
    session: process.env.HARNERY_AGENT_COORD_SESSION_ID,
    platform: process.env.HARNERY_AGENT_COORD_PLATFORM,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["HARNERY_COORD_ROOT_OVERRIDE", saved.override],
      ["CLAUDE_PROJECT_DIR", saved.projectDir],
      ["HARNERY_AGENT_COORD_SESSION_ID", saved.session],
      ["HARNERY_AGENT_COORD_PLATFORM", saved.platform],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("session registered in the submodule → the submodule root (this bug)", () => {
    const { nested, session } = makeFixture();
    seedSession(nested, session);
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session;
    process.env.HARNERY_AGENT_COORD_PLATFORM = "claude-code";
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
    process.env.HARNERY_AGENT_COORD_PLATFORM = "claude-code";
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;

    expect(resolveCoordRoot(nested)).toBe(outer);
  });

  test("no root knows the session → nearest enclosing .harnery/", () => {
    const { nested, session } = makeFixture();
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session; // registered nowhere
    process.env.HARNERY_AGENT_COORD_PLATFORM = "claude-code";
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;

    expect(resolveCoordRoot(nested)).toBe(nested);
  });

  test("a stale cache row does not claim the session", () => {
    const { outer, nested, session } = makeFixture();
    seedSession(outer, session);
    writeFileSync(
      join(nested, ".harnery", "active", `${session}.json`),
      JSON.stringify({
        instance_id: session,
        session_id: session,
        last_heartbeat: "2000-01-01T00:00:00.000Z",
      }),
    );
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session;
    process.env.HARNERY_AGENT_COORD_PLATFORM = "claude-code";
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;

    expect(resolveCoordRoot(nested)).toBe(outer);
  });

  test("CLAUDE_PROJECT_DIR and the explicit override still take precedence", () => {
    const { outer, nested, session } = makeFixture();
    seedSession(nested, session);
    process.env.HARNERY_AGENT_COORD_SESSION_ID = session;
    process.env.HARNERY_AGENT_COORD_PLATFORM = "claude-code";

    process.env.CLAUDE_PROJECT_DIR = outer;
    expect(resolveCoordRoot(nested)).toBe(outer);

    process.env.HARNERY_COORD_ROOT_OVERRIDE = nested;
    expect(resolveCoordRoot(outer)).toBe(nested);
  });
});
