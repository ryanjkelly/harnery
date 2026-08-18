/**
 * Resolution tests: adapter detection, pid-map row format, and owner
 * resolution.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parsePidmapRowPlatform,
  pidStartToken,
  resolveOwnerBySessionEnv,
  resolveOwnerWithSource,
  resolveSingleActiveOwner,
  sessionIdentityFromEnv,
} from "../../src/core/agents/coord-client.ts";
import { ensureLiveCoordinationHeartbeat } from "../../src/core/agents/state/live-coordination-view.ts";
import { writePidmapRow } from "../../src/core/agents/state/pidmap.ts";
import { processStartToken } from "../../src/core/agents/state/proc-start.ts";
import { initializeEventLedgerV3 } from "../../src/core/events/v3/bootstrap.ts";
import { sha256V3 } from "../../src/core/events/v3/canonical.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-routing.ts";
import { detectAdapter } from "../../src/core/hooks/adapter/detect.ts";
import { findCoordRoot } from "../../src/core/hooks/resolve/coord-root.ts";
import {
  listPidmap,
  resolveOwner as resolveHookOwner,
} from "../../src/core/hooks/resolve/owner.ts";
import { initializeV2Fixture, seedV2Session } from "../helpers/event-v2.ts";

// Mirror of the source's SESSION_ID_ENV_VARS (kept unexported there); used here
// only to save/restore env across tests.
const SESSION_ID_ENV_KEYS = [
  "HARNERY_AGENT_COORD_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CURSOR_SESSION_ID",
  "CURSOR_CONVERSATION_ID",
  "CODEX_SESSION_ID",
  "CODEX_THREAD_ID",
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
    const journal = mkdtempSync(path.join(os.tmpdir(), "harn-journal-"));
    try {
      expect(findCoordRoot(journal)).toBe(root);
    } finally {
      rmSync(journal, { recursive: true, force: true });
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

describe("detectAdapter", () => {
  const saved = process.env.HARNERY_AGENT_COORD_ADAPTER;
  afterEach(() => {
    if (saved === undefined) delete process.env.HARNERY_AGENT_COORD_ADAPTER;
    else process.env.HARNERY_AGENT_COORD_ADAPTER = saved;
  });

  test("--adapter flag wins (both spaced + = form)", () => {
    expect(detectAdapter(["--adapter", "cursor"])).toBe("cursor");
    expect(detectAdapter(["--adapter=codex"])).toBe("codex");
  });

  test("falls back to HARNERY_AGENT_COORD_ADAPTER env when flag absent", () => {
    process.env.HARNERY_AGENT_COORD_ADAPTER = "cursor";
    expect(detectAdapter([])).toBe("cursor");
  });

  test("accepts the canonical claude-code adapter id", () => {
    expect(detectAdapter(["--adapter", "claude-code"])).toBe("claude-code");
    process.env.HARNERY_AGENT_COORD_ADAPTER = "claude-code";
    expect(detectAdapter([])).toBe("claude-code");
  });

  test("unknown / missing → null", () => {
    delete process.env.HARNERY_AGENT_COORD_ADAPTER;
    expect(detectAdapter([])).toBeNull();
    expect(detectAdapter(["--adapter", "emacs"])).toBeNull();
  });
});

describe("pid-map row format + resolveOwner", () => {
  let root: string;
  const savedOwner = process.env.HARNERY_AGENT_COORD_OWNER;
  const savedBridge = process.env.HARNERY_AGENT_COORD_BRIDGE;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-resolve-"));
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    delete process.env.HARNERY_AGENT_COORD_OWNER;
    delete process.env.HARNERY_AGENT_COORD_BRIDGE;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedOwner === undefined) delete process.env.HARNERY_AGENT_COORD_OWNER;
    else process.env.HARNERY_AGENT_COORD_OWNER = savedOwner;
    if (savedBridge === undefined) delete process.env.HARNERY_AGENT_COORD_BRIDGE;
    else process.env.HARNERY_AGENT_COORD_BRIDGE = savedBridge;
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
    expect(resolveHookOwner({ payload: null, coordRoot: root })).toEqual({
      instance_id: "env-owner-id",
      source: "env",
    });
  });

  test("resolveOwner reads payload ids when env unset (source=payload)", () => {
    const got = resolveHookOwner({ payload: { session_id: "pay-sess" }, coordRoot: root });
    expect(got).toEqual({ instance_id: "pay-sess", source: "payload" });
  });

  test("resolveOwner payload precedence: agent_id > session_id", () => {
    const got = resolveHookOwner({
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
      "ghost-agent\tclaude-code\tl1",
      "utf8",
    );
    expect(resolveHookOwner({ payload: null, coordRoot: root })).toBeNull();
  });

  test("resolveOwner still trusts a live row written before start tokens existed", () => {
    writeFileSync(
      path.join(root, ".harnery", "pid-map", String(process.pid)),
      "legacy-agent\tclaude-code",
      "utf8",
    );
    expect(resolveHookOwner({ payload: null, coordRoot: root })?.instance_id).toBe("legacy-agent");
  });

  test("platform parses out of a row that also carries a start token", () => {
    // The third field must not leak into the platform, or the walk stops
    // preferring the adapter row and silently downgrades to a fallback match.
    expect(parsePidmapRowPlatform("sess-abc\tcursor\tl12345")).toBe("cursor");
    expect(parsePidmapRowPlatform("sess-abc\tcursor")).toBe("cursor");
    expect(parsePidmapRowPlatform("sess-abc")).toBe("claude-code");
  });

  test("resolveOwner returns null when env unset, no payload, no pid-map hit", () => {
    // empty pid-map dir + no payload → null (the test runner's pid chain has no
    // entry in this fresh tmp root)
    expect(resolveHookOwner({ payload: null, coordRoot: root })).toBeNull();
  });
});

describe("resolveSingleActiveOwner (sole live V2 producer)", () => {
  let root: string;
  let activeDir: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-singleton-"));
    activeDir = path.join(root, ".harnery", "active");
    mkdirSync(activeDir, { recursive: true });
    initializeV2Fixture(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a missing disposable cache does not hide the sole live V2 producer", () => {
    seedV2Session(root, "only-one", { sessionId: "session-one" });
    rmSync(activeDir, { recursive: true, force: true });
    expect(resolveSingleActiveOwner(root)).toBe("only-one");
  });

  test("zero live agents → null", () => {
    expect(resolveSingleActiveOwner(root)).toBeNull();
  });

  test("exactly one live V2 producer resolves its native instance id", () => {
    seedV2Session(root, "only-one", { sessionId: "session-one" });
    expect(resolveSingleActiveOwner(root)).toBe("only-one");
  });

  test("two live V2 producers are ambiguous", () => {
    seedV2Session(root, "agent-a", { sessionId: "session-a" });
    seedV2Session(root, "agent-b", { sessionId: "session-b" });
    expect(resolveSingleActiveOwner(root)).toBeNull();
  });

  test("poisoned V1-shaped cache files cannot create or hide owners", () => {
    writeFileSync(path.join(activeDir, "broken.json"), "{ not valid json");
    writeFileSync(
      path.join(activeDir, "ghost.json"),
      JSON.stringify({ instance_id: "ghost", session_id: "ghost-session" }),
    );
    seedV2Session(root, "good", { sessionId: "session-good" });
    expect(resolveSingleActiveOwner(root)).toBe("good");
  });
});

describe("resolveOwnerBySessionEnv (adapter session id → live V2 producer)", () => {
  let root: string;
  const SAVED = SESSION_ID_ENV_KEYS.map((k) => [k, process.env[k]] as const);
  const savedCursorAgent = process.env.CURSOR_AGENT;
  const savedPlatform = process.env.HARNERY_AGENT_COORD_PLATFORM;
  const savedRootOverride = process.env.HARNERY_COORD_ROOT_OVERRIDE;
  const savedBridge = process.env.HARNERY_AGENT_COORD_BRIDGE;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-session-env-"));
    initializeV2Fixture(root);
    for (const k of SESSION_ID_ENV_KEYS) delete process.env[k];
    delete process.env.HARNERY_AGENT_COORD_BRIDGE;
    delete process.env.HARNERY_AGENT_COORD_PLATFORM;
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
    if (savedBridge === undefined) delete process.env.HARNERY_AGENT_COORD_BRIDGE;
    else process.env.HARNERY_AGENT_COORD_BRIDGE = savedBridge;
  });

  test("no session-id env var → null", () => {
    seedV2Session(root, "agent-a", { sessionId: "sess-a", adapter: "claude-code" });
    expect(resolveOwnerBySessionEnv(root)).toBeNull();
  });

  test("CLAUDE_CODE_SESSION_ID matches a live V2 producer", () => {
    seedV2Session(root, "agent-a", { sessionId: "sess-a", adapter: "claude-code" });
    seedV2Session(root, "agent-b", { sessionId: "sess-b", adapter: "claude-code" });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-b";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-b");
  });

  test("session identity disambiguates multiple live V2 producers", () => {
    seedV2Session(root, "agent-a", { sessionId: "sess-a", adapter: "claude-code" });
    seedV2Session(root, "agent-b", { sessionId: "sess-b", adapter: "claude-code" });
    seedV2Session(root, "agent-c", { sessionId: "sess-c", adapter: "claude-code" });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-c";
    expect(resolveSingleActiveOwner(root)).toBeNull();
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-c");
  });

  test("session id with no matching V2 producer → null", () => {
    seedV2Session(root, "agent-a", { sessionId: "sess-a", adapter: "claude-code" });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-nope";
    expect(resolveOwnerBySessionEnv(root)).toBeNull();
  });

  test("HARNERY_AGENT_COORD_SESSION_ID override wins over adapter vars", () => {
    seedV2Session(root, "agent-a", { sessionId: "sess-a", adapter: "claude-code" });
    seedV2Session(root, "agent-b", { sessionId: "sess-b", adapter: "claude-code" });
    process.env.CLAUDE_CODE_SESSION_ID = "sess-a";
    process.env.HARNERY_AGENT_COORD_SESSION_ID = "sess-b";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-b");
  });

  test("Cursor and Codex session-id env vars resolve their adapter producers", () => {
    seedV2Session(root, "agent-cur", { sessionId: "sess-cur", adapter: "cursor" });
    process.env.CURSOR_SESSION_ID = "sess-cur";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-cur");
    delete process.env.CURSOR_SESSION_ID;

    seedV2Session(root, "agent-cdx", { sessionId: "sess-cdx", adapter: "codex" });
    process.env.CODEX_SESSION_ID = "sess-cdx";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-cdx");
    delete process.env.CODEX_SESSION_ID;

    seedV2Session(root, "agent-cdx-thread", { sessionId: "thread-cdx", adapter: "codex" });
    process.env.CODEX_THREAD_ID = "thread-cdx";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-cdx-thread");
  });

  test("Cursor conversation id env resolves and strips the Glass bc- prefix", () => {
    seedV2Session(root, "agent-cur", { sessionId: "sess-cur", adapter: "cursor" });
    process.env.CURSOR_CONVERSATION_ID = "bc-sess-cur";
    expect(resolveOwnerBySessionEnv(root)).toBe("agent-cur");
  });

  test("Cursor Glass prefers the canonical bare conversation id", () => {
    process.env.CURSOR_CONVERSATION_ID = "bc-sess-cur";
    seedV2Session(root, "named-bare", { sessionId: "sess-cur", adapter: "cursor" });
    expect(resolveOwnerBySessionEnv(root)).toBe("named-bare");
  });

  test("Claude Code session env wins over a recycled pid-map row", () => {
    // The row names this pid, but the pid was recycled: it now belongs to us,
    // and the agent that wrote the row is long gone. The walk cannot tell,
    // and the pruner cannot help, since the pid is alive. The env var can.
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    seedV2Session(root, "agent-current", {
      sessionId: "sess-current",
      adapter: "claude-code",
    });
    seedV2Session(root, "agent-recycled", {
      sessionId: "sess-recycled",
      adapter: "claude-code",
    });
    writePidmapRow(root, process.pid, "agent-recycled", "claude-code");

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
    writePidmapRow(root, process.pid, "agent-from-row", "claude-code");

    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    process.env.CLAUDE_CODE_SESSION_ID = "sess-with-no-heartbeat";

    expect(resolveOwnerWithSource()).toEqual({
      owner: "agent-from-row",
      source: "pidmap",
    });
  });

  test("Cursor session env wins over a shared cursor pid-map row", () => {
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    seedV2Session(root, "agent-current", { sessionId: "sess-current", adapter: "cursor" });
    seedV2Session(root, "agent-shared-row", { sessionId: "sess-shared", adapter: "cursor" });
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

describe("sessionIdentityFromEnv (unvalidated registration-point identity)", () => {
  const SAVED = SESSION_ID_ENV_KEYS.map((k) => [k, process.env[k]] as const);

  beforeEach(() => {
    for (const k of SESSION_ID_ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of SAVED) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("returns the stamped session id with NO live heartbeat required", () => {
    // A fresh bridge session has no heartbeat until its first set-task, so the
    // heartbeat-validated resolver returns null there by design; the
    // registration-point identity must still be readable.
    process.env.CODEX_THREAD_ID = "fresh-thread-no-heartbeat";
    expect(sessionIdentityFromEnv()).toBe("fresh-thread-no-heartbeat");
  });

  test("returns null when no session-id env var is present", () => {
    expect(sessionIdentityFromEnv()).toBeNull();
  });
});

describe("codex-wsl bridge owner parity", () => {
  let root: string;
  let activeDir: string;
  const ENV_KEYS = [
    ...SESSION_ID_ENV_KEYS,
    "HARNERY_AGENT_COORD_OWNER",
    "HARNERY_AGENT_COORD_BRIDGE",
    "HARNERY_AGENT_COORD_PLATFORM",
    "HARNERY_COORD_ROOT_OVERRIDE",
  ] as const;
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "harn-codex-wsl-owner-"));
    activeDir = path.join(root, ".harnery", "active");
    mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
    initializeEventLedgerV3({
      coordRoot: root,
      harneryBuild: "fixture",
      hostBuild: "fixture",
      configDigest: sha256V3("config"),
      approvalRecordId: "test-codex-wsl-owner",
    });
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
    process.env.HARNERY_AGENT_COORD_BRIDGE = "codex-wsl";
    process.env.HARNERY_AGENT_COORD_PLATFORM = "codex";
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function writeHeartbeat(id: string, sessionId: string): void {
    const route = resolveLiveEventLedgerRouteV3(root);
    if (route.state !== "v3") throw new Error("expected V3 route");
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-start",
      payload: { session_id: sessionId, raw: {} },
      adapter: "codex",
      instanceId: id,
    });
    const cache = ensureLiveCoordinationHeartbeat(root, id, sessionId, "codex");
    if (!cache) throw new Error("expected V2 cache");
    writeFileSync(
      path.join(activeDir, `${id}.json`),
      JSON.stringify({
        ...cache,
        kind: "session",
        name: id,
        last_heartbeat: new Date().toISOString(),
      }),
    );
  }

  test("validated bridge command identity does not grant payload-free hook identity", () => {
    writeHeartbeat("codex-owner", "codex-thread");
    writeHeartbeat("foreign-owner", "foreign-session");
    writePidmapRow(root, process.pid, "foreign-owner", "claude-code");
    process.env.HARNERY_AGENT_COORD_OWNER = "foreign-owner";
    process.env.HARNERY_AGENT_COORD_SESSION_ID = "codex-thread";
    process.env.CODEX_THREAD_ID = "codex-thread";

    expect(resolveOwnerWithSource()).toEqual({
      owner: "codex-owner",
      source: "session_env",
    });
    expect(resolveHookOwner({ payload: null, coordRoot: root })).toBeNull();
  });

  test("invalid bridge session fails closed across both resolvers", () => {
    writeHeartbeat("foreign-owner", "foreign-session");
    writePidmapRow(root, process.pid, "foreign-owner", "claude-code");
    process.env.HARNERY_AGENT_COORD_OWNER = "foreign-owner";
    process.env.HARNERY_AGENT_COORD_SESSION_ID = "missing-thread";
    process.env.CODEX_THREAD_ID = "missing-thread";

    expect(resolveOwnerWithSource()).toEqual({ owner: null, source: "none" });
    expect(resolveHookOwner({ payload: null, coordRoot: root })).toBeNull();
  });

  test("hook payload remains authoritative in bridge mode", () => {
    expect(resolveHookOwner({ payload: { session_id: "payload-owner" }, coordRoot: root })).toEqual(
      { instance_id: "payload-owner", source: "payload" },
    );
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
