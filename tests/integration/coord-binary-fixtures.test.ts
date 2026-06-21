/**
 * Cross-harness binary-integration fixtures: end-to-end CLI plumbing tests for
 * the `agent-hook` / `agent-coord` binaries. They exercise the wiring that the
 * function-level unit tests (names-pool, coord-resolve, claim-conflict,
 * commit-conflict, coord-reader, heartbeat-writer-heal) don't reach: that a real
 * Cursor sessionStart payload routed through the real `agent-hook` binary writes
 * a heartbeat to the override coord-root, that a Codex stop verdict fails when
 * set-task is missing, etc. We spawn the production entry points the way the
 * harnesses' hooks.json / settings.json do.
 *
 * Why spawn the real binaries instead of importing the TS: this is the only
 * coverage that exercises the wrapper-script → bun → cli.ts → shelled-out
 * agent-coord chain. The unit tests cover the rule logic; these cover the wiring.
 *
 * Mechanics:
 *   - each test gets a fresh mkdtemp coord-root, git-init'd + seed commit so
 *     path canonicalization's `git rev-parse` resolves.
 *   - `<root>/harnery` is symlinked to the real harnery tree because
 *     hooks/cli.ts resolves the agent-coord binary it shells out to as
 *     join(coordRoot, "harnery", "bin", "agent-coord").
 *   - HARNERY_COORD_ROOT_OVERRIDE=<root> sends all coord state into the sandbox.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Layout-agnostic: the harnery repo root is two levels up from this file
// (tests/integration/). Works both standalone (repo root == harnery) and when
// embedded in a host monorepo (repo root == <host>/harnery). The sandbox below
// symlinks <coordRoot>/harnery -> HARNERY_DIR to satisfy the coord layer's
// join(coordRoot, "harnery", "bin", "agent-coord") resolution.
const HARNERY_DIR = path.resolve(import.meta.dir, "../..");
const AGENT_HOOK = path.join(HARNERY_DIR, "bin", "agent-hook");
const AGENT_COORD = path.join(HARNERY_DIR, "bin", "agent-coord");
const HARN = path.join(HARNERY_DIR, "bin", "harn");
const sandboxes: string[] = [];

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeSandbox(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-binfix-"));
  sandboxes.push(root);
  mkdirSync(path.join(root, ".harnery", "active"), { recursive: true });
  mkdirSync(path.join(root, ".harnery", "pid-map"), { recursive: true });
  writeFileSync(path.join(root, ".harnery", ".lock"), "");
  // hooks/cli.ts resolves agent-coord at <coordRoot>/harnery/bin/agent-coord.
  symlinkSync(HARNERY_DIR, path.join(root, "harnery"));
  // git repo so canonicalize's `git rev-parse --show-toplevel` resolves to root.
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: "ignore" });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  git(["add", "seed.txt"]);
  git(["commit", "-qm", "seed"]);
  return root;
}

interface HeartbeatOpts {
  ts?: string;
  files?: string[];
  name?: string;
  platform?: string;
  schemaVersion?: number;
  extra?: Record<string, unknown>;
}

function seedHeartbeat(root: string, owner: string, opts: HeartbeatOpts = {}): void {
  const ts = opts.ts ?? nowIso();
  const body: Record<string, unknown> = {
    instance_id: owner,
    session_id: owner,
    agent_id: "",
    model: "test",
    started_at: ts,
    last_heartbeat: ts,
    files_touched: opts.files ?? [],
  };
  if (opts.schemaVersion !== undefined) body.schema_version = opts.schemaVersion;
  if (opts.name !== undefined) body.name = opts.name;
  if (opts.platform !== undefined) body.platform = opts.platform;
  Object.assign(body, opts.extra ?? {});
  writeFileSync(path.join(root, ".harnery", "active", `${owner}.json`), JSON.stringify(body));
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function run(
  bin: string,
  args: string[],
  payload: string,
  root: string,
  extraEnv: Record<string, string> = {},
): RunResult {
  const r = spawnSync("bash", [bin, ...args], {
    input: payload,
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root, ...extraEnv },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function events(root: string): string {
  const p = path.join(root, ".harnery", "events.ndjson");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function activeCount(root: string): number {
  const dir = path.join(root, ".harnery", "active");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).length : 0;
}

afterEach(() => {
  while (sandboxes.length) {
    const s = sandboxes.pop();
    if (s) rmSync(s, { recursive: true, force: true });
  }
});

// ── agent-hook pre-tool-use (claude-code) ─────────────────────────────────
describe("agent-hook pre-tool-use [claude-code]", () => {
  const payload = JSON.stringify({
    session_id: "owner-B",
    tool_name: "Bash",
    tool_input: { command: "echo hi" },
    cwd: "/tmp",
    hook_event_name: "PreToolUse",
  });
  const anchor = { HARNERY_AGENT_COORD_TEST_ANCHOR_PID: "77777" };

  test("writes pid-map row for the anchor PID on Bash payload", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "owner-B", {
      ts: "2026-05-28T16:00:00Z",
      schemaVersion: 1,
      name: "Pim",
      platform: "claude_code",
      extra: { kind: "session" },
    });
    expect(existsSync(path.join(root, ".harnery", "pid-map", "77777"))).toBe(false);
    run(AGENT_HOOK, ["pre-tool-use", "--harness", "claude-code"], payload, root, anchor);
    expect(readFileSync(path.join(root, ".harnery", "pid-map", "77777"), "utf8")).toBe(
      "owner-B\tclaude_code",
    );
  });

  test("second call is a no-op (idempotent pid-map, mtime unchanged)", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "owner-B", { schemaVersion: 1, platform: "claude_code" });
    run(AGENT_HOOK, ["pre-tool-use", "--harness", "claude-code"], payload, root, anchor);
    const rowPath = path.join(root, ".harnery", "pid-map", "77777");
    const before = statSync(rowPath).mtimeMs;
    run(AGENT_HOOK, ["pre-tool-use", "--harness", "claude-code"], payload, root, anchor);
    expect(statSync(rowPath).mtimeMs).toBe(before);
  });

  test("stale pid-map row is rewritten to the current owner", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "owner-B", { schemaVersion: 1, platform: "claude_code" });
    const rowPath = path.join(root, ".harnery", "pid-map", "77777");
    writeFileSync(rowPath, "owner-OLD\tclaude_code\n");
    run(AGENT_HOOK, ["pre-tool-use", "--harness", "claude-code"], payload, root, anchor);
    expect(readFileSync(rowPath, "utf8")).toBe("owner-B\tclaude_code");
  });
});

// ── agent-hook pre-tool-use cross-client deny (cursor / codex) ─────────────
describe("agent-hook pre-tool-use cross-client deny", () => {
  test("Cursor Write on a held path is denied + names the holding agent", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "cc-owner", {
      files: ["docs/shared.md"],
      name: "Adelaide",
      platform: "claude_code",
    });
    seedHeartbeat(root, "cursor-session", { name: "Bertha", platform: "cursor" });
    mkdirSync(path.join(root, "docs"), { recursive: true });
    writeFileSync(path.join(root, "docs", "shared.md"), "shared\n");
    const payload = JSON.stringify({
      conversation_id: "cursor-session",
      session_id: "cursor-session",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "docs", "shared.md") },
      hook_event_name: "preToolUse",
      cursor_version: "3.5.17",
      workspace_roots: [root],
    });
    const { stdout } = run(AGENT_HOOK, ["pre-tool-use", "--harness", "cursor"], payload, root);
    expect(stdout).toContain('"permission":"deny"');
    expect(stdout).toContain("agent-Adelaide");
  });

  test("Codex apply_patch on a held path is denied", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "cc-blocker-codex", {
      files: ["docs/codex-conflict.md"],
      name: "Blocker",
      platform: "claude_code",
    });
    const patch = `*** Begin Patch\n*** Update File: ${root}/docs/codex-conflict.md\n@@\n-old\n+new\n*** End Patch\n`;
    const payload = JSON.stringify({
      session_id: "codex-conflict-sess",
      cwd: root,
      hook_event_name: "PreToolUse",
      model: "gpt-5.5",
      permission_mode: "bypassPermissions",
      tool_name: "apply_patch",
      tool_input: { command: patch },
      tool_use_id: "call_codex_test",
    });
    const { stdout } = run(AGENT_HOOK, ["pre-tool-use", "--harness", "codex"], payload, root);
    expect(stdout).toContain('"permissionDecision":"deny"');
  });
});

// ── agent-hook session-start (cursor / codex) ─────────────────────────────
describe("agent-hook session-start", () => {
  test("Cursor sessionStart sweeps stale heartbeat, keeps fresh, creates own", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "stale-cc", {
      ts: nowIso(-2 * 60 * 60 * 1000),
      files: ["abandoned.txt"],
      name: "Ghost",
      platform: "claude_code",
    });
    seedHeartbeat(root, "fresh-cc", { name: "Alive", platform: "claude_code" });
    const sid = "new-cursor-sess";
    const payload = JSON.stringify({
      conversation_id: sid,
      session_id: sid,
      model: "composer-2.5-fast",
      hook_event_name: "sessionStart",
      cursor_version: "3.5.17",
      workspace_roots: [root],
    });
    run(AGENT_HOOK, ["session-start", "--harness", "cursor"], payload, root);
    expect(existsSync(path.join(root, ".harnery", "active", "stale-cc.json"))).toBe(false);
    expect(existsSync(path.join(root, ".harnery", "active", "fresh-cc.json"))).toBe(true);
    expect(existsSync(path.join(root, ".harnery", "active", `${sid}.json`))).toBe(true);
  });

  test("cursor sessionStart lands a heartbeat in the override sandbox + exits 0", () => {
    const root = makeSandbox();
    const sid = "test-replay-session";
    const payload = JSON.stringify({
      conversation_id: sid,
      session_id: sid,
      hook_event_name: "sessionStart",
      cursor_version: "test",
      workspace_roots: [root],
      cwd: root,
      model: "test-replay",
      composer_mode: "agent",
      is_background_agent: false,
    });
    const { status } = run(AGENT_HOOK, ["session-start", "--harness", "cursor"], payload, root);
    expect(status).toBe(0);
    expect(activeCount(root)).toBe(1);
  });

  test("Codex sessionStart creates a heartbeat", () => {
    const root = makeSandbox();
    const sid = "codex-fixture-sess";
    const payload = JSON.stringify({
      session_id: sid,
      cwd: root,
      hook_event_name: "SessionStart",
      model: "gpt-5.5",
      permission_mode: "bypassPermissions",
      source: "startup",
    });
    run(AGENT_HOOK, ["session-start", "--harness", "codex"], payload, root);
    expect(existsSync(path.join(root, ".harnery", "active", `${sid}.json`))).toBe(true);
  });
});

// ── agent-hook user-prompt-submit peer refresh + task nudge ────────────────
describe("agent-hook user-prompt-submit", () => {
  test("cursor beforeSubmitPrompt emits additional_context naming the peer", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "cc-peer", {
      files: ["docs/a.md"],
      name: "Adelaide",
      platform: "claude_code",
    });
    seedHeartbeat(root, "cursor-me", { name: "Bertha", platform: "cursor" });
    const payload = JSON.stringify({
      conversation_id: "cursor-me",
      session_id: "cursor-me",
      hook_event_name: "beforeSubmitPrompt",
      cursor_version: "3.5.17",
      workspace_roots: [root],
      prompt: "continue work",
    });
    const { stdout } = run(AGENT_HOOK, ["user-prompt-submit", "--harness", "cursor"], payload, root);
    expect(stdout).toContain('"additional_context"');
    expect(stdout).toContain("agent-Adelaide");
  });

  test("cursor nudges when task is null", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "cursor-task-null", { name: "Bertha", platform: "cursor" });
    const payload = JSON.stringify({
      conversation_id: "cursor-task-null",
      session_id: "cursor-task-null",
      hook_event_name: "beforeSubmitPrompt",
      cursor_version: "3.5.17",
      workspace_roots: [root],
      prompt: "do something",
    });
    const { stdout } = run(AGENT_HOOK, ["user-prompt-submit", "--harness", "cursor"], payload, root);
    expect(stdout).toContain("task` field is unset");
  });

  test("cursor nudges on a stale task, then dedupes the repeat", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "cursor-task-stale", {
      name: "Bertha",
      platform: "cursor",
      extra: { task: "old workstream", task_updated_at: nowIso(-2 * 60 * 60 * 1000) },
    });
    const mk = (prompt: string) =>
      JSON.stringify({
        conversation_id: "cursor-task-stale",
        session_id: "cursor-task-stale",
        hook_event_name: "beforeSubmitPrompt",
        cursor_version: "3.5.17",
        workspace_roots: [root],
        prompt,
      });
    const first = run(
      AGENT_HOOK,
      ["user-prompt-submit", "--harness", "cursor"],
      mk("continue"),
      root,
    );
    expect(first.stdout).toContain("hasn't changed in");
    expect(first.stdout).toContain("old workstream");
    // same state hit again → hash dedupe, no re-nudge.
    const second = run(
      AGENT_HOOK,
      ["user-prompt-submit", "--harness", "cursor"],
      mk("still continuing"),
      root,
    );
    expect(second.stdout).not.toContain("hasn't changed in");
  });

  test("codex nudges when task is null", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "codex-task-null", { name: "Bertha", platform: "codex" });
    const payload = JSON.stringify({
      session_id: "codex-task-null",
      cwd: root,
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.5",
      permission_mode: "bypassPermissions",
      prompt: "do something",
    });
    const { stdout } = run(AGENT_HOOK, ["user-prompt-submit", "--harness", "codex"], payload, root);
    expect(stdout).toContain("task` field is unset");
  });
});

// ── codex: shell-mutation warn + stop verdict ──────────────────────────────
describe("codex stop + shell-warn via agent-hook", () => {
  test("codex Bash redirect emits canonical shell-mutation decision.warn", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "codex-shell-warn", { name: "Bertha", platform: "codex" });
    const payload = JSON.stringify({
      session_id: "codex-shell-warn",
      cwd: root,
      hook_event_name: "PreToolUse",
      model: "gpt-5.5",
      permission_mode: "bypassPermissions",
      tool_name: "Bash",
      tool_input: { command: "echo hi > docs/shell-write-target.md" },
      tool_use_id: "call_codex_test",
    });
    run(AGENT_HOOK, ["pre-tool-use", "--harness", "codex"], payload, root);
    const ev = events(root);
    expect(ev).toContain('"event_type":"decision.warn"');
    expect(ev).toContain("shell_mutation_candidate");
    expect(ev).toMatch(/path=docs\/shell-write-target\.md.*platform=codex/);
  });

  const codexTranscript = (root: string, lines: string[]): string => {
    const p = path.join(root, ".harnery", "codex-fixture-transcript.jsonl");
    writeFileSync(p, `${lines.join("\n")}\n`);
    return p;
  };
  const META = '{"timestamp":"2026-05-24T00:00:00Z","type":"session_meta","payload":{}}';
  const USER =
    '{"timestamp":"2026-05-24T00:00:05Z","type":"event_msg","payload":{"type":"user_message","message":"do work"}}';
  const fn = (ts: string, cmd: string) =>
    JSON.stringify({
      timestamp: ts,
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) },
    });
  const BOX = "┌─ agent-Test ─┐\n│ ... │\n└──────────────┘";

  test("codex stop passes with status + set-task in JSONL and box pasted", () => {
    const root = makeSandbox();
    const tp = codexTranscript(root, [
      META,
      USER,
      fn("2026-05-24T00:00:10Z", "harn agents status"),
      fn("2026-05-24T00:00:11Z", 'harn agents set-task "focused"'),
    ]);
    const payload = JSON.stringify({
      session_id: "codex-full-pass",
      cwd: root,
      hook_event_name: "Stop",
      model: "gpt-5.5",
      permission_mode: "bypassPermissions",
      stop_hook_active: false,
      transcript_path: tp,
      last_assistant_message: `reply with box:\n${BOX}`,
    });
    expect(run(AGENT_HOOK, ["stop", "--harness", "codex"], payload, root).status).toBe(0);
  });

  test("codex stop FAILS (exit 2, rule 3/3) when set-task missing from JSONL", () => {
    const root = makeSandbox();
    const tp = codexTranscript(root, [META, USER, fn("2026-05-24T00:00:10Z", "harn agents status")]);
    const payload = JSON.stringify({
      session_id: "codex-full-miss-settask",
      cwd: root,
      hook_event_name: "Stop",
      model: "gpt-5.5",
      permission_mode: "bypassPermissions",
      stop_hook_active: false,
      transcript_path: tp,
      last_assistant_message: `reply:\n${BOX}`,
    });
    const { status, stderr } = run(AGENT_HOOK, ["stop", "--harness", "codex"], payload, root);
    expect(status).toBe(2);
    expect(stderr).toContain("rule (3/3)");
  });

  test("codex stop matches wrapped invocations (cd && bp; PATH= bp)", () => {
    const root = makeSandbox();
    const tp = codexTranscript(root, [
      META,
      USER,
      fn("2026-05-24T00:00:10Z", "cd /home/<user> && harn agents status"),
      fn("2026-05-24T00:00:11Z", 'PATH=$PWD/bin:$PATH harn agents set-task "focused"'),
    ]);
    const payload = JSON.stringify({
      session_id: "codex-wrapped-invoke",
      cwd: root,
      hook_event_name: "Stop",
      model: "gpt-5.5",
      permission_mode: "bypassPermissions",
      stop_hook_active: false,
      transcript_path: tp,
      last_assistant_message: `reply with box:\n${BOX}`,
    });
    expect(run(AGENT_HOOK, ["stop", "--harness", "codex"], payload, root).status).toBe(0);
  });

  test("codex stop passes with the box in last_assistant_message (text-only)", () => {
    const root = makeSandbox();
    const payload = JSON.stringify({
      session_id: "codex-textonly",
      cwd: root,
      hook_event_name: "Stop",
      model: "gpt-5.5",
      permission_mode: "bypassPermissions",
      stop_hook_active: false,
      last_assistant_message: `Here is the agent status:\n\n${BOX}`,
    });
    expect(run(AGENT_HOOK, ["stop", "--harness", "codex"], payload, root).status).toBe(0);
  });
});

// ── cursor before-shell-execution shell-warn via agent-hook ─────────────────
describe("cursor before-shell-execution shell-warn", () => {
  test("emits exactly one shell_mutation_candidate decision.warn event", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "shell-me", { name: "Shell", platform: "cursor" });
    // beforeShellExecution resolves the owner via pid-map walk.
    writeFileSync(path.join(root, ".harnery", "pid-map", String(process.pid)), "shell-me\tcursor\n");
    const payload = JSON.stringify({
      conversation_id: "shell-me",
      session_id: "shell-me",
      command: "echo x > docs/shell-test.txt",
      hook_event_name: "beforeShellExecution",
      cursor_version: "3.5.17",
      workspace_roots: [root],
    });
    run(AGENT_HOOK, ["before-shell-execution", "--harness", "cursor"], payload, root, {
      HARNERY_AGENT_COORD_OFF: "0",
    });
    const count = events(root)
      .split("\n")
      .filter((l) => l.includes("shell_mutation_candidate")).length;
    expect(count).toBe(1);
  });
});

// ── agent-coord direct subcommands ─────────────────────────────────────────
describe("agent-coord subcommands", () => {
  test("shell-mutation-paths extracts a redirect target", () => {
    const root = makeSandbox();
    const r = spawnSync(
      "bash",
      [AGENT_COORD, "shell-mutation-paths", "--cmd", "echo hi > docs/shell-out.txt"],
      { cwd: root, encoding: "utf8", env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root } },
    );
    expect(r.stdout ?? "").toContain("docs/shell-out.txt");
  });

  test("stamp-status-call writes last_status_at", () => {
    const root = makeSandbox();
    const owner = "11111111-2222-3333-4444-555555555555";
    seedHeartbeat(root, owner, { ts: "2026-05-24T00:00:00Z" });
    run(AGENT_COORD, ["stamp-status-call", owner], "", root);
    const hb = JSON.parse(readFileSync(path.join(root, ".harnery", "active", `${owner}.json`), "utf8"));
    expect(String(hb.last_status_at ?? "")).toContain("T");
  });
});

// ── claude-code claim-guard + session-start via agent-hook ──────────────────
describe("claude-code pre-tool-use deny + session-start", () => {
  test("Edit on an overlapping path is denied + names the blocking owner", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "other-owner", { files: ["docs/foo.md"] });
    seedHeartbeat(root, "test-me", {});
    const payload = JSON.stringify({
      session_id: "test-me",
      tool_name: "Edit",
      tool_input: { file_path: path.join(root, "docs", "foo.md") },
      cwd: root,
      hook_event_name: "PreToolUse",
    });
    const { stdout } = run(AGENT_HOOK, ["pre-tool-use", "--harness", "claude-code"], payload, root);
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain("agent-other-ow");
  });

  test("Edit on a Cursor-held path is denied + names the Cursor agent", () => {
    const root = makeSandbox();
    seedHeartbeat(root, "cursor-owner", {
      files: ["docs/shared.md"],
      name: "Bertha",
      platform: "cursor",
    });
    seedHeartbeat(root, "cc-session", {});
    const payload = JSON.stringify({
      session_id: "cc-session",
      tool_name: "Edit",
      tool_input: { file_path: path.join(root, "docs", "shared.md") },
      cwd: root,
      hook_event_name: "PreToolUse",
    });
    const { stdout } = run(AGENT_HOOK, ["pre-tool-use", "--harness", "claude-code"], payload, root);
    expect(stdout).toContain('"permissionDecision":"deny"');
    expect(stdout).toContain("agent-Bertha");
  });

  test("claude-code session-start creates a heartbeat", () => {
    const root = makeSandbox();
    const sid = "cc-fixture-sess";
    // The production SessionStart entry is `agent-hook session-start
    // --harness claude-code` directly.
    const payload = JSON.stringify({ session_id: sid, model: "claude-sonnet-4-6", source: "startup" });
    run(AGENT_HOOK, ["session-start", "--harness", "claude-code"], payload, root);
    expect(existsSync(path.join(root, ".harnery", "active", `${sid}.json`))).toBe(true);
  });
});

// ── harn agents harness-probe ───────────────────────────────────────────────
// The probe is TS-native (resolveOwner + an inline /proc walk). This test locks
// the wiring: it emits valid JSON with all the expected keys and a
// dispatch_entry that points at the live agent-hook entry.
describe("harn agents harness-probe (TS-native)", () => {
  test("emits valid JSON with all keys + the corrected dispatch_entry", () => {
    const r = spawnSync("bash", [HARN, "agents", "harness-probe", "claude_code", "--json"], {
      cwd: HARNERY_DIR,
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(r.status).toBe(0);
    const data = JSON.parse((r.stdout ?? "").trim());
    // Shape: the 8 fields the probe has always reported.
    for (const key of [
      "harness",
      "anchor_pid",
      "hook_pid",
      "resolved_owner",
      "ppid_chain",
      "dispatch_entry",
      "note",
    ]) {
      expect(data).toHaveProperty(key);
    }
    // dispatch_entry points at the live agent-hook entry.
    expect(data.dispatch_entry).toBe("harnery/bin/agent-hook session-start --harness claude-code");
  });
});
