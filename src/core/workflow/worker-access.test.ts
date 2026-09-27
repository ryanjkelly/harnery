import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParentAccessEvidence } from "./types.ts";
import {
  decideWorkerAccess,
  detectParentAccess,
  lastLineContaining,
  type ParentAccessDeps,
  parseWorkerFullAccessPolicy,
  type WorkerAccessInput,
} from "./worker-access.ts";

const policy = parseWorkerFullAccessPolicy({
  enabled: true,
  floors: {
    codex: [{ model: "gpt-strong", minEffort: "medium" }],
    "claude-code": [
      { model: "claude-strong", minEffort: "medium" },
      { model: "claude-other", minEffort: "high" },
    ],
    cursor: [{ model: "vendor-model-high" }, { model: "vendor-model-xhigh" }],
  },
});

const fullParent: ParentAccessEvidence = {
  state: "full-access",
  adapters: ["codex"],
  detail: "the parent runs unsandboxed",
};

function decide(overrides: Partial<WorkerAccessInput>) {
  return decideWorkerAccess({
    adapter: "codex",
    model: "gpt-strong",
    effort: "medium",
    policy,
    parent: () => fullParent,
    ...overrides,
  });
}

describe("parseWorkerFullAccessPolicy", () => {
  test("absent config is disabled, not invalid", () => {
    expect(parseWorkerFullAccessPolicy(undefined)).toEqual({ enabled: false, floors: {} });
  });

  test("a valid policy keeps its floors", () => {
    expect(policy.invalid).toBeUndefined();
    expect(policy.enabled).toBe(true);
    expect(policy.floors.codex).toEqual([{ model: "gpt-strong", minEffort: "medium" }]);
    expect(policy.floors.cursor).toEqual([
      { model: "vendor-model-high" },
      { model: "vendor-model-xhigh" },
    ]);
  });

  test("any malformed part disables the whole policy", () => {
    const cases: unknown[] = [
      "yes",
      { enabled: "true" },
      { enabled: true, extra: 1 },
      { enabled: true, floors: [] },
      { enabled: true, floors: { nope: [] } },
      { enabled: true, floors: { codex: {} } },
      { enabled: true, floors: { codex: [{ model: "", minEffort: "high" }] } },
      { enabled: true, floors: { codex: [{ model: "m" }] } },
      { enabled: true, floors: { codex: [{ model: "m", minEffort: "extreme" }] } },
      { enabled: true, floors: { cursor: [{ model: "m", minEffort: "high" }] } },
      { enabled: true, floors: { codex: [{ model: "m", minEffort: "high", note: "x" }] } },
    ];
    for (const raw of cases) {
      const parsed = parseWorkerFullAccessPolicy(raw);
      expect(parsed.enabled).toBe(false);
      expect(parsed.invalid).toBeString();
    }
  });
});

describe("decideWorkerAccess", () => {
  test("disabled config keeps the sandbox", () => {
    const decision = decide({
      policy: parseWorkerFullAccessPolicy({ enabled: false, floors: {} }),
    });
    expect(decision).toMatchObject({ mode: "sandboxed", reason: "disabled" });
  });

  test("an invalid config keeps the sandbox and says why", () => {
    const decision = decide({ policy: parseWorkerFullAccessPolicy({ enabled: "on" }) });
    expect(decision.mode).toBe("sandboxed");
    expect(decision.reason).toBe("config_invalid");
    expect(decision.detail).toContain("enabled must be a boolean");
  });

  test("a sandboxed parent never hands full access down", () => {
    const decision = decide({
      parent: () => ({ state: "sandboxed", adapters: ["codex"], detail: "workspace-write" }),
    });
    expect(decision).toMatchObject({ mode: "sandboxed", reason: "parent_sandboxed" });
  });

  test("an unknown parent fails closed", () => {
    const decision = decide({
      parent: () => ({ state: "unknown", adapters: [], detail: "no marker" }),
    });
    expect(decision).toMatchObject({ mode: "sandboxed", reason: "parent_unknown" });
  });

  test("models off the list, unset models, and weak efforts stay sandboxed", () => {
    expect(decide({ model: "gpt-weaker" }).reason).toBe("model_not_listed");
    expect(decide({ model: undefined }).reason).toBe("model_unset");
    expect(decide({ effort: "low" }).reason).toBe("effort_below_floor");
    expect(decide({ effort: undefined }).reason).toBe("effort_unset");
    expect(decide({ adapter: "claude-code", model: "claude-other", effort: "medium" }).reason).toBe(
      "effort_below_floor",
    );
    expect(
      decide({ adapter: "cursor", model: "vendor-model-medium", effort: undefined }).reason,
    ).toBe("model_not_listed");
  });

  test("an adapter with no floors stays sandboxed", () => {
    const onlyCodex = parseWorkerFullAccessPolicy({
      enabled: true,
      floors: { codex: [{ model: "gpt-strong", minEffort: "medium" }] },
    });
    expect(
      decide({ adapter: "claude-code", model: "claude-strong", policy: onlyCodex }).reason,
    ).toBe("model_not_listed");
  });

  test("an adapter with no full-access rendering never qualifies", () => {
    const decision = decide({ adapter: "opencode", model: "provider/model", effort: undefined });
    expect(decision).toMatchObject({ mode: "sandboxed", reason: "adapter_unrepresentable" });
  });

  test("a read-only run policy is honored", () => {
    const decision = decide({ filesystemPolicy: { mode: "read-only" } });
    expect(decision).toMatchObject({ mode: "sandboxed", reason: "policy_read_only" });
  });

  test("qualifying codex, claude, and cursor workers get full access", () => {
    expect(decide({}).mode).toBe("full-access");
    expect(decide({ effort: "xhigh" }).mode).toBe("full-access");
    expect(decide({ filesystemPolicy: { mode: "workspace-write" } }).mode).toBe("full-access");
    expect(decide({ adapter: "claude-code", model: "claude-strong", effort: "max" }).mode).toBe(
      "full-access",
    );
    expect(decide({ adapter: "claude-code", model: "claude-other", effort: "high" }).mode).toBe(
      "full-access",
    );
    const cursor = decide({ adapter: "cursor", model: "vendor-model-xhigh", effort: undefined });
    expect(cursor).toMatchObject({ mode: "full-access", reason: "qualified" });
    expect(cursor.detail).toContain("the parent runs unsandboxed");
  });

  test("the parent is probed only after every cheaper condition passes", () => {
    let probes = 0;
    const parent = () => {
      probes++;
      return fullParent;
    };
    decide({ model: "gpt-weaker", parent });
    decide({ effort: "low", parent });
    decide({ policy: parseWorkerFullAccessPolicy(undefined), parent });
    expect(probes).toBe(0);
    decide({ parent });
    expect(probes).toBe(1);
  });
});

describe("detectParentAccess", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `worker-access-${process.pid}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // UUIDv7 for 2026-09-27T02:04:48.480Z, whose rollout sits in the 2026/09/26
  // folder for a creator west of UTC.
  const threadId = "01a0e09b-97e0-7b51-afc4-06debef8de5b";

  function deps(
    env: Record<string, string>,
    overrides: Partial<ParentAccessDeps> = {},
  ): ParentAccessDeps {
    return {
      env,
      platform: "linux",
      homeDir: join(root, "home"),
      procStatus: () => "Name:\tbun\nNoNewPrivs:\t0\nSeccomp:\t0\n",
      windowsUserRoots: () => [],
      ...overrides,
    };
  }

  function writeRollout(home: string, sandbox: string): void {
    const dir = join(home, "sessions", "2026", "09", "26");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "session_meta", payload: { id: threadId } }),
      JSON.stringify({ type: "turn_context", payload: { sandbox_policy: { type: "read-only" } } }),
      JSON.stringify({ type: "response_item", payload: { text: "x" } }),
      JSON.stringify({ type: "turn_context", payload: { sandbox_policy: { type: sandbox } } }),
      JSON.stringify({ type: "event_msg", payload: { text: "y" } }),
    ];
    writeFileSync(
      join(dir, `rollout-2026-09-26T21-04-48-${threadId}.jsonl`),
      `${lines.join("\n")}\n`,
    );
  }

  function writeTranscript(mode: string): void {
    const dir = join(root, "home", ".claude", "projects", "-work-repo");
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ type: "user", permissionMode: "default" }),
      JSON.stringify({
        type: "assistant",
        message: { content: '"permissionMode":"bypassPermissions"' },
      }),
      JSON.stringify({ type: "user", permissionMode: mode }),
      JSON.stringify({ type: "assistant", message: { content: "done" } }),
    ];
    writeFileSync(join(dir, "claude-session.jsonl"), `${lines.join("\n")}\n`);
  }

  test("no adapter marker is unknown", () => {
    expect(detectParentAccess(deps({})).state).toBe("unknown");
  });

  test("a Codex parent whose latest turn ran danger-full-access has full access", () => {
    writeRollout(join(root, "home", ".codex"), "danger-full-access");
    const evidence = detectParentAccess(deps({ CODEX_THREAD_ID: threadId }));
    expect(evidence.state).toBe("full-access");
    expect(evidence.adapters).toEqual(["codex"]);
  });

  test("a Codex parent on workspace-write is sandboxed", () => {
    writeRollout(join(root, "home", ".codex"), "workspace-write");
    expect(detectParentAccess(deps({ CODEX_THREAD_ID: threadId })).state).toBe("sandboxed");
  });

  test("a Windows Codex home seen from WSL is found", () => {
    const windowsUser = join(root, "Users", "someone");
    writeRollout(join(windowsUser, ".codex"), "danger-full-access");
    const evidence = detectParentAccess(
      deps(
        { CODEX_THREAD_ID: threadId, WSL_DISTRO_NAME: "Distro" },
        { windowsUserRoots: () => [windowsUser] },
      ),
    );
    expect(evidence.state).toBe("full-access");
    // Without the WSL marker the Windows profile is not searched.
    expect(
      detectParentAccess(
        deps({ CODEX_THREAD_ID: threadId }, { windowsUserRoots: () => [windowsUser] }),
      ).state,
    ).toBe("unknown");
  });

  test("a missing rollout or a non-v7 thread id is unknown", () => {
    expect(detectParentAccess(deps({ CODEX_THREAD_ID: threadId })).state).toBe("unknown");
    expect(detectParentAccess(deps({ CODEX_THREAD_ID: "not-a-uuid" })).state).toBe("unknown");
  });

  test("Codex sandbox variables or no_new_privs mean the process is confined", () => {
    writeRollout(join(root, "home", ".codex"), "danger-full-access");
    expect(
      detectParentAccess(deps({ CODEX_THREAD_ID: threadId, CODEX_SANDBOX_NETWORK_DISABLED: "1" }))
        .state,
    ).toBe("sandboxed");
    expect(
      detectParentAccess(
        deps({ CODEX_THREAD_ID: threadId }, { procStatus: () => "NoNewPrivs:\t1\n" }),
      ).state,
    ).toBe("sandboxed");
    expect(
      detectParentAccess(deps({ CODEX_THREAD_ID: threadId }, { procStatus: () => null })).state,
    ).toBe("unknown");
  });

  test("a Claude Code parent in bypassPermissions has full access; other modes do not", () => {
    writeTranscript("bypassPermissions");
    expect(detectParentAccess(deps({ CLAUDE_CODE_SESSION_ID: "claude-session" })).state).toBe(
      "full-access",
    );
    writeTranscript("acceptEdits");
    expect(detectParentAccess(deps({ CLAUDE_CODE_SESSION_ID: "claude-session" })).state).toBe(
      "sandboxed",
    );
  });

  test("a Claude Code parent off Linux is unknown, since its Bash sandbox cannot be ruled out", () => {
    writeTranscript("bypassPermissions");
    expect(
      detectParentAccess(deps({ CLAUDE_CODE_SESSION_ID: "claude-session" }, { platform: "darwin" }))
        .state,
    ).toBe("unknown");
  });

  test("a nested launch needs every marker to prove full access", () => {
    writeTranscript("bypassPermissions");
    writeRollout(join(root, "home", ".codex"), "workspace-write");
    const nested = { CLAUDE_CODE_SESSION_ID: "claude-session", CODEX_THREAD_ID: threadId };
    expect(detectParentAccess(deps(nested)).state).toBe("sandboxed");
    writeRollout(join(root, "home", ".codex"), "danger-full-access");
    expect(detectParentAccess(deps(nested)).state).toBe("full-access");
  });

  test("Cursor and OpenCode parents are unknown", () => {
    expect(detectParentAccess(deps({ CURSOR_SESSION_ID: "c1" })).state).toBe("unknown");
    expect(detectParentAccess(deps({ OPENCODE_SESSION_ID: "o1" })).state).toBe("unknown");
  });
});

describe("lastLineContaining", () => {
  test("finds the last matching line across read chunks", () => {
    const dir = join(tmpdir(), `worker-access-lines-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "big.jsonl");
    const filler = "x".repeat(1024 * 1024 + 17);
    writeFileSync(path, `{"k":"first"}\n{"k":"second","pad":"${filler}"}\n{"other":1}\n`);
    try {
      expect(lastLineContaining(path, '"k":"')).toStartWith('{"k":"second"');
      expect(lastLineContaining(path, '"missing"')).toBeNull();
      expect(lastLineContaining(join(dir, "absent.jsonl"), '"k"')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
