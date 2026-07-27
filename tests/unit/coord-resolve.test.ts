/**
 * Resolution tests: harness detection, pid-map row format, and owner
 * resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCoordRoot } from "../../src/core/hooks/resolve/coord-root.ts";
import { detectHarness } from "../../src/core/hooks/harness/detect.ts";
import { listPidmap, resolveOwner } from "../../src/core/hooks/resolve/owner.ts";
import { writePidmapRow } from "../../src/core/agents/state/pidmap.ts";
import {
  parsePidmapRowPlatform,
  pidStartToken,
  resolveOwnerBySessionEnv,
  resolveOwnerWithSource,
  resolveSingleActiveOwner,
} from "../../src/core/agents/coord-client.ts";
import { processStartToken } from "../../src/core/agents/state/proc-start.ts";

// Mirror of the source's SESSION_ID_ENV_VARS (kept unexported there); used here
// only to save/restore env across tests.
const SESSION_ID_ENV_KEYS = [
  "HARNERY_AGENT_COORD_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CURSOR_SESSION_ID",
  "CURSOR_CONVERSATION_ID",
  "CODEX_SESSION_ID",
] as const;

describe("findCoordRoot (hooks-side)", () => {
  let root: string;
  let nested: string;
  const savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
  const savedOverride = process.env.HARNERY_COORD_ROOT_OVERRIDE;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-coord-root-"));
    mkdirSync(path.join(root, ".harnery"), { recursive: true });
    // A nested "submodule" carrying its own .harnery (the accidental-root trap).
    nested = path.join(root, "sub-repo");
    mkdirSync(path.join(nested, ".harnery"), { recursive: true });
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
    if (savedOverride === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
    else process.env.HARNERY_COORD_ROOT_OVERRIDE = savedOverride;
  });

  test("walks up from start when no env is set (nested root wins from inside it)", () => {
    expect(findCoordRoot(nested)).toBe(nested);
    expect(findCoordRoot(path.join(root, "some", "plain", "dir"))).toBe(root);
  });

  test("CLAUDE_PROJECT_DIR beats the cwd walk (hook cwd wandered into a nested root)", () => {
    process.env.CLAUDE_PROJECT_DIR = root;
    expect(findCoordRoot(nested)).toBe(root);
  });

  test("CLAUDE_PROJECT_DIR beats an off-root cwd with no .harnery anywhere", () => {
    process.env.CLAUDE_PROJECT_DIR = root;
    const scratch = mkdtempSync(path.join(os.tmpdir(), "harn-scratch-"));
    try {
      expect(findCoordRoot(scratch)).toBe(root);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("falls back to the cwd walk when CLAUDE_PROJECT_DIR has no coord root above it", () => {
    // The project dir must have no coord root anywhere above it, so it cannot
    // sit under the system temp dir: anything that leaves a `.harnery` in /tmp
    // would resolve at step 2 and quietly mask the fallback this test covers.
    // A nonexistent path one level below the filesystem root has exactly one
    // ancestor, and the assertion below proves the premise before relying on it.
    const bare = path.join(path.parse(process.cwd()).root, `harn-absent-${process.pid}`);
    expect(findCoordRoot(bare)).toBe(null);
    process.env.CLAUDE_PROJECT_DIR = bare;
    expect(findCoordRoot(nested)).toBe(nested);
  });

  test("HARNERY_COORD_ROOT_OVERRIDE beats CLAUDE_PROJECT_DIR", () => {
    process.env.CLAUDE_PROJECT_DIR = root;
    process.env.HARNERY_COORD_ROOT_OVERRIDE = nested;
    expect(findCoordRoot(root)).toBe(nested);
  });
});

describe("detectHarness", () => {
  const saved = process.env.HARNERY_AGENT_COORD_HARNESS;
  afterEach(() => {
    if (saved === undefined) delete process.env.HARNERY_AGENT_COORD_HARNESS;
    else process.env.HARNERY_AGENT_COORD_HARNESS = saved;
  });

  test("--harness flag wins (both spaced + = form)", () => {
    expect(detectHarness(["--harness", "cursor"])).toBe("cursor");
    expect(detectHarness(["--harness=codex"])).toBe("codex");
  });

  test("falls back to HARNERY_AGENT_COORD_HARNESS env when flag absent", () => {
    process.env.HARNERY_AGENT_COORD_HARNESS = "cursor";
    expect(detectHarness([])).toBe("cursor");
  });

  test("legacy claude_code (underscore) maps to claude-code", () => {
    expect(detectHarness(["--harness", "claude_code"])).toBe("claude-code");
    process.env.HARNERY_AGENT_COORD_HARNESS = "claude_code";
    expect(detectHarness([])).toBe("claude-code");
  });

  test("unknown / missing → null", () => {
    delete process.env.HARNERY_AGENT_COORD_HARNESS;
    expect(detectHarness([])).toBeNull();
    expect(detectHarness(["--harness", "emacs"])).toBeNull();
  });
});

describe("pid-map row format + resolveOwner", () => {
  let root: string;
  const savedOwner = process.env.HARNERY_AGENT_COORD_OWNER;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-resolve-"));
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    delete process.env.HARNERY_AGENT_COORD_OWNER;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedOwner === undefined) delete process.env.HARNERY_AGENT_COORD_OWNER;
    else process.env.HARNERY_AGENT_COORD_OWNER = savedOwner;
  });

  test("writePidmapRow writes `<instance_id>\\t<platform>` + is idempotent", () => {
    writePidmapRow(root, 4242, "sess-abc", "cursor");
    const rows = listPidmap(root);
    const row = rows.find((r) => r.pid === 4242);
    expect(row?.owner).toBe("sess-abc"); // listPidmap splits on the tab, returns owner
    // idempotent re-write: no throw, same result
    writePidmapRow(root, 4242, "sess-abc", "cursor");
    expect(listPidmap(root).filter((r) => r.pid === 4242).length).toBe(1);
  });

  test("resolveOwner honors HARNERY_AGENT_COORD_OWNER env (source=env)", () => {
    process.env.HARNERY_AGENT_COORD_OWNER = "env-owner-id";
    expect(resolveOwner({ payload: null, coordRoot: root })).toEqual({
      instance_id: "env-owner-id",
      source: "env",
    });
  });

  test("resolveOwner reads payload ids when env unset (source=payload)", () => {
    const got = resolveOwner({ payload: { session_id: "pay-sess" }, coordRoot: root });
    expect(got).toEqual({ instance_id: "pay-sess", source: "payload" });
  });

  test("resolveOwner payload precedence: agent_id > session_id", () => {
    const got = resolveOwner({
      payload: { agent_id: "agent-x", session_id: "sess-y" },
      coordRoot: root,
    });
    expect(got?.instance_id).toBe("agent-x");
  });

  test("resolveOwner walks past a row whose pid was re-issued", () => {
    // A row naming our own live pid on behalf of a departed agent. Without the
    // start-token check this resolves the current session to that agent's
    // identity, which is what `whoami` was seen doing.
    writeFileSync(
      path.join(root, ".harnery", "pid-map", String(process.pid)),
      "ghost-agent\tclaude_code\tl1",
      "utf8",
    );
    expect(resolveOwner({ payload: null, coordRoot: root })).toBeNull();
  });

  test("resolveOwner still trusts a live row written before start tokens existed", () => {
    writeFileSync(
      path.join(root, ".harnery", "pid-map", String(process.pid)),
      "legacy-agent\tclaude_code",
      "utf8",
    );
    expect(resolveOwner({ payload: null, coordRoot: root })?.instance_id).toBe("legacy-agent");
  });

  test("platform parses out of a row that also carries a start token", () => {
    // The third field must not leak into the platform, or the walk stops
    // preferring the harness row and silently downgrades to a fallback match.
    expect(parsePidmapRowPlatform("sess-abc\tcursor\tl12345")).toBe("cursor");
    expect(parsePidmapRowPlatform("sess-abc\tcursor")).toBe("cursor");
    expect(parsePidmapRowPlatform("sess-abc")).toBe("claude_code");
  });

  test("resolveOwner returns null when env unset, no payload, no pid-map hit", () => {
    // empty pid-map dir + no payload → null (the test runner's pid chain has no
    // entry in this fresh tmp root)
    expect(resolveOwner({ payload: null, coordRoot: root })).toBeNull();
  });
});

describe("resolveSingleActiveOwner (ppid-walk fallback for the sole live agent)", () => {
  let root: string;
  let activeDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-singleton-"));
    activeDir = path.join(root, ".harnery", "active");
    mkdirSync(activeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  function writeHeartbeat(id: string, agoMs: number): void {
    writeFileSync(
      path.join(activeDir, `${id}.json`),
      JSON.stringify({ instance_id: id, last_heartbeat: isoAgo(agoMs) }),
    );
  }

  test("missing active/ dir → null", () => {
    rmSync(activeDir, { recursive: true, force: true });
    expect(resolveSingleActiveOwner(root)).toBeNull();
  });

  test("zero live agents → null", () => {
    expect(resolveSingleActiveOwner(root)).toBeNull();
  });

  test("exactly one live agent → its instance_id", () => {
    writeHeartbeat("only-one", 30_000);
    expect(resolveSingleActiveOwner(root)).toBe("only-one");
  });

  test("two live agents → null (ambiguous, require --session-id)", () => {
    writeHeartbeat("agent-a", 10_000);
    writeHeartbeat("agent-b", 20_000);
    expect(resolveSingleActiveOwner(root)).toBeNull();
  });

  test("one live + one stale → resolves the live one (stale ignored)", () => {
    writeHeartbeat("fresh", 30_000);
    writeHeartbeat("stale", 11 * 60 * 1000); // older than the 600s window
    expect(resolveSingleActiveOwner(root)).toBe("fresh");
  });

  test("malformed heartbeat files are skipped", () => {
    writeFileSync(path.join(activeDir, "broken.json"), "{ not valid json");
    writeFileSync(path.join(activeDir, "no-ts.json"), JSON.stringify({ instance_id: "x" }));
    writeHeartbeat("good", 30_000);
    expect(resolveSingleActiveOwner(root)).toBe("good");
  });

  test("non-.json entries ignored", () => {
    writeFileSync(path.join(activeDir, "notes.txt"), "ignore me");
    writeHeartbeat("good", 30_000);
    expect(resolveSingleActiveOwner(root)).toBe("good");
  });
});

describe("resolveOwnerBySessionEnv (harness session-id env → live heartbeat)", () => {
  let root: string;
  let activeDir: string;
  const SAVED = SESSION_ID_ENV_KEYS.map((k) => [k, process.env[k]] as const);
  const savedCursorAgent = process.env.CURSOR_AGENT;
  const savedPlatform = process.env.HARNERY_AGENT_COORD_PLATFORM;
  const savedRootOverride = process.env.HARNERY_COORD_ROOT_OVERRIDE;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-session-env-"));
    activeDir = path.join(root, ".harnery", "active");
    mkdirSync(activeDir, { recursive: true });
    for (const k of SESSION_ID_ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [k, v] of SAVED) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (savedCursorAgent === undefined) delete process.env.CURSOR_AGENT;
    else process.env.CURSOR_AGENT = savedCursorAgent;
    if (savedPlatform === undefined) delete process.env.HARNERY_AGENT_COORD_PLATFORM;
    else process.env.HARNERY_AGENT_COORD_PLATFORM = savedPlatform;
    if (savedRootOverride === undefined) delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
    else process.env.HARNERY_COORD_ROOT_OVERRIDE = savedRootOverride;
  });

  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  function writeHeartbeat(id: string, sessionId: string, agoMs: number): void {
    writeFileSync(
      path.join(activeDir, `${id}.json`),
      JSON.stringify({ instance_id: id, session_id: sessionId, last_heartbeat: isoAgo(agoMs) }),
    );
  }

  test("no session-id env var → null", () => {
    writeHeartbeat("agent-a", "sess-a", 30_000);
    expect(resolveOwnerBySessionEnv(root)).toBeNull();
  });

  test("CLAUDE_CODE_SESSION_ID matches a live heartbeat → its instance_id", () => {
    writeHeartbeat("agent-a", "sess-a", 30_000);
    writeHeartbeat("agent-b", "sess-b", 30_000);
    process.env.CLAUDE_CODE_SESSION_ID = "sess-b";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-b");
  });

  test("disambiguates among multiple live agents (the singleton fallback can't)", () => {
    writeHeartbeat("agent-a", "sess-a", 10_000);
    writeHeartbeat("agent-b", "sess-b", 20_000);
    writeHeartbeat("agent-c", "sess-c", 30_000);
    process.env.CLAUDE_CODE_SESSION_ID = "sess-c";
    expect(resolveSingleActiveOwner(root)).toBeNull(); // 3 live → ambiguous
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-c");
  });

  test("session id with no matching heartbeat → null", () => {
    writeHeartbeat("agent-a", "sess-a", 30_000);
    process.env.CLAUDE_CODE_SESSION_ID = "sess-nope";
    expect(resolveOwnerBySessionEnv(root)).toBeNull();
  });

  test("stale heartbeat for the matching session → null", () => {
    writeHeartbeat("agent-a", "sess-a", 11 * 60 * 1000); // older than 600s
    process.env.CLAUDE_CODE_SESSION_ID = "sess-a";
    expect(resolveOwnerBySessionEnv(root)).toBeNull();
  });

  test("HARNERY_AGENT_COORD_SESSION_ID override wins over harness vars", () => {
    writeHeartbeat("agent-a", "sess-a", 30_000);
    writeHeartbeat("agent-b", "sess-b", 30_000);
    process.env.CLAUDE_CODE_SESSION_ID = "sess-a";
    process.env.HARNERY_AGENT_COORD_SESSION_ID = "sess-b";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-b");
  });

  test("Cursor + Codex session-id env vars also resolve", () => {
    writeHeartbeat("agent-cur", "sess-cur", 30_000);
    process.env.CURSOR_SESSION_ID = "sess-cur";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-cur");
    delete process.env.CURSOR_SESSION_ID;

    writeHeartbeat("agent-cdx", "sess-cdx", 30_000);
    process.env.CODEX_SESSION_ID = "sess-cdx";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-cdx");
  });

  test("Cursor conversation id env resolves and strips the Glass bc- prefix", () => {
    writeHeartbeat("agent-cur", "sess-cur", 30_000);
    process.env.CURSOR_CONVERSATION_ID = "bc-sess-cur";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-cur");
  });

  test("Claude Code session env wins over a recycled pid-map row", () => {
    // The row names this pid, but the pid was recycled: it now belongs to us,
    // and the agent that wrote the row is long gone. The walk cannot tell,
    // and the pruner cannot help, since the pid is alive. The env var can.
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    writeHeartbeat("agent-current", "sess-current", 30_000);
    writeHeartbeat("agent-recycled", "sess-recycled", 30_000);
    writePidmapRow(root, process.pid, "agent-recycled", "claude_code");

    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    process.env.CLAUDE_CODE_SESSION_ID = "sess-current";

    expect(resolveOwnerWithSource()).toEqual({
      owner: "agent-current",
      source: "session_env",
    });
  });

  test("pid-map still resolves when the session env names no live heartbeat", () => {
    // Preferring the env must not cost us the walk: an env session id with no
    // matching heartbeat has to fall through, not resolve to nothing.
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    writePidmapRow(root, process.pid, "agent-from-row", "claude_code");

    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    process.env.CLAUDE_CODE_SESSION_ID = "sess-with-no-heartbeat";

    expect(resolveOwnerWithSource()).toEqual({
      owner: "agent-from-row",
      source: "pidmap",
    });
  });

  test("Cursor session env wins over a shared cursor pid-map row", () => {
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    writeHeartbeat("agent-current", "sess-current", 30_000);
    writeHeartbeat("agent-shared-row", "sess-shared", 30_000);
    writePidmapRow(root, process.pid, "agent-shared-row", "cursor");

    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    process.env.CURSOR_AGENT = "1";
    process.env.CURSOR_CONVERSATION_ID = "sess-current";

    expect(resolveOwnerWithSource()).toEqual({
      owner: "agent-current",
      source: "session_env",
    });
  });
});

/**
 * The start token is a wire format: `state/proc-start.ts` writes rows,
 * `coord-client.ts` reads them during the ppid walk, and the host's commit
 * guard reimplements it again in bash. The first two copies exist because
 * coord-client is vendored downstream and may not import; nothing but a test
 * stops them drifting, and a drift is silent — one side simply starts calling
 * the other's live rows recycled.
 */
describe("start-token parity between the two implementations", () => {
  let savedProbe: string | undefined;

  beforeEach(() => {
    savedProbe = process.env.HARNERY_PID_PROBE;
  });

  afterEach(() => {
    if (savedProbe === undefined) delete process.env.HARNERY_PID_PROBE;
    else process.env.HARNERY_PID_PROBE = savedProbe;
  });

  test("both read the same token for one live process, in either dialect", () => {
    for (const probe of ["procfs", "ps"] as const) {
      process.env.HARNERY_PID_PROBE = probe;
      const canonical = processStartToken(process.pid);
      if (canonical === null) continue; // no procfs on this machine
      expect(pidStartToken(process.pid)).toBe(canonical);
    }
  });

  test("both decline for a pid that is not running", () => {
    let dead = 30000;
    while (dead < 40000) {
      try {
        process.kill(dead, 0);
        dead += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        dead += 1;
      }
    }
    expect(pidStartToken(dead)).toBe(processStartToken(dead) as string | null);
  });
});
