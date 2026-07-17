/**
 * `agent-coord` CLI entry point. Phase 1: every subcommand no-ops with a
 * structured debug log. The one exception is `verdict`, which replies
 * fail-open so adapters can already wire it up without affecting flow.
 *
 * Phase 2 replaces the no-op branches with real state projection + CLI
 * handlers; Phase 4 flips the default so `harn agents …` shims through here.
 */

import { appendFileSync, existsSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { coordEnv } from "../../lib/env.ts";

function findCoordRoot(start: string): string | null {
  // HARNERY_COORD_ROOT_OVERRIDE: the bash side's test-mode escape hatch. agent-coord
  // honors the same env so sandboxed test runs don't get derailed when cwd
  // doesn't contain a .harnery/ tree. Phase 8: dropped the `.harnery/` existence
  // precondition so test fixtures that haven't bootstrapped the dir yet still
  // resolve.
  const override = coordEnv("COORD_ROOT_OVERRIDE");
  if (override) return override;
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".harnery"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function logNoop(root: string, subcommand: string, argv: string[]): Promise<void> {
  const logPath = join(root, ".harnery", "debug", "agent-coord.ndjson");
  await mkdir(dirname(logPath), { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    note: "called, no-op",
    subcommand,
    extra_argv: argv,
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
  };
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Verdict endpoint. Reads a JSON request from stdin, dispatches to the
 * matching rule evaluator, writes a JSON verdict to stdout. Exit code is
 * 0 regardless; the caller branches on the JSON's `exit_code` field so
 * fail-open semantics survive a malformed-request bug here.
 *
 * The Stop and PreToolUse hooks route here.
 */
async function handleVerdict(root: string): Promise<number> {
  const raw = await readStdin();
  const logPath = join(root, ".harnery", "debug", "agent-coord-verdict.ndjson");
  await mkdir(dirname(logPath), { recursive: true });

  let parsed: { rule?: string } & Record<string, unknown> = {};
  let parseErr: string | null = null;
  try {
    if (raw.trim().length > 0) {
      parsed = JSON.parse(raw) as { rule?: string } & Record<string, unknown>;
    }
  } catch (err) {
    parseErr = err instanceof Error ? err.message : String(err);
  }

  let verdict: {
    allow: boolean;
    exit_code: number;
    rule: string;
    reason?: string;
  };

  if (parseErr) {
    verdict = {
      allow: true,
      exit_code: 0,
      rule: "verdict.bad_request",
      reason: `invalid JSON: ${parseErr} (fail-open)`,
    };
  } else if (parsed.rule === "stop-hook") {
    const { evaluateStopHook } = await import("./rules/stop-hook.ts");
    verdict = evaluateStopHook(root, parsed as unknown as Parameters<typeof evaluateStopHook>[1]);
  } else if (parsed.rule === "claim") {
    const { evaluateClaim } = await import("./rules/claim-conflict.ts");
    verdict = evaluateClaim(root, parsed as unknown as Parameters<typeof evaluateClaim>[1]);
  } else if (parsed.rule === "commit") {
    const { evaluateCommit } = await import("./rules/commit-conflict.ts");
    const result = evaluateCommit(root, parsed as unknown as Parameters<typeof evaluateCommit>[1]);
    // Map CommitVerdictResult → the standard verdict envelope, stash details
    // on extra fields so the bash caller can pull conflicts + log_lines.
    verdict = {
      allow: result.allow,
      exit_code: result.exit_code,
      rule: result.rule,
      reason: result.message,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    } as typeof verdict;
    (verdict as Record<string, unknown>).conflicts = result.conflicts;
    (verdict as Record<string, unknown>).log_lines = result.log_lines;
    (verdict as Record<string, unknown>).suppressed_self_attribution =
      result.suppressed_self_attribution ?? false;
  } else {
    verdict = {
      allow: true,
      exit_code: 0,
      rule: "verdict.unknown_rule",
      reason: `no evaluator for rule=${parsed.rule ?? "<missing>"} (fail-open)`,
    };
  }

  await appendFile(
    logPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      request_preview: raw.slice(0, 500),
      verdict,
    })}\n`,
    "utf8",
  );

  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  return 0;
}

async function handleProject(root: string, rest: string[]): Promise<number> {
  const { consumeSince, writeCursor } = await import("./events/consume.ts");
  const { projectHeartbeats } = await import("./state/heartbeat-projector.ts");
  const replayAll = rest.includes("--replay-all");
  const result = consumeSince(root, { replayAll });
  const project = projectHeartbeats(root, result.events);
  const report = {
    events_consumed: result.events.length,
    stream_bytes: result.streamBytes,
    owners_projected: project.written.length,
    owners: project.written,
    cursor: result.lastEventId,
    replayed_all: replayAll,
  };
  if (result.lastEventId) writeCursor(root, result.lastEventId);
  if (rest.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `projected ${report.events_consumed} events across ${report.owners_projected} owners\n  cursor → ${report.cursor ?? "<none>"}\n${
        report.owners.length
          ? `  owners: ${report.owners.map((o) => o.slice(0, 8)).join(", ")}\n`
          : ""
      }`,
    );
  }
  return 0;
}

/**
 * Append a canonical `claim.release` event for a path dropped from an owner's
 * files_touched. The path is canonicalized to repo-relative (matching the
 * projector's normalization) so the subtraction matches on replay regardless
 * of the form the caller passed. Soft-fails: a failed emit must never break
 * the release/kill flow — the file mutation already happened.
 */
async function emitClaimRelease(
  root: string,
  owner: string,
  hb: { session_id?: string; platform?: string },
  path: string,
  reason: "explicit" | "heal" | "commit" | "checkout",
): Promise<void> {
  try {
    const { emit } = await import("./events/emit.ts");
    const canonical = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
    const platform = hb.platform;
    const harness =
      platform === "cursor" ? "cursor" : platform === "codex" ? "codex" : "claude-code";
    emit(root, {
      event_type: "claim.release",
      instance_id: owner,
      session_id: hb.session_id ?? owner,
      harness,
      source: "agent-coord",
      data: { path: canonical, reason },
    });
  } catch {
    /* soft-fail: never break the caller */
  }
}

async function handleStateAction(root: string, action: string, rest: string[]): Promise<number> {
  const writer = await import("./state/heartbeat-writer.ts");
  const [owner, ...args] = rest;
  if (!owner) {
    process.stderr.write(`agent-coord ${action}: missing <instance_id>\n`);
    return 2;
  }

  switch (action) {
    case "set-task": {
      const task = args.join(" ");
      const hb = writer.setTask(root, owner, task);
      if (!hb) {
        // Name the RESOLVED root: when a nested .harnery/ shadows the real
        // coordination home, the full path is what makes that diagnosable.
        process.stderr.write(
          `agent-coord set-task: no heartbeat at ${root}/.harnery/active/${owner}.json\n`,
        );
        return 1;
      }
      process.stdout.write(
        `${JSON.stringify({ instance_id: owner, task: hb.task ?? null, cleared: !task })}\n`,
      );
      return 0;
    }
    case "stamp-status-call": {
      const hb = writer.stampStatusCheck(root, owner);
      if (!hb) return 1;
      process.stdout.write(
        `${JSON.stringify({ instance_id: owner, last_status_at: hb.last_status_at })}\n`,
      );
      return 0;
    }
    case "set-turn-summary": {
      const summary = args.join(" ");
      const hb = writer.setTurnSummary(root, owner, summary);
      if (!hb) return 1;
      process.stdout.write(
        `${JSON.stringify({ instance_id: owner, turn_summary: hb.turn_summary })}\n`,
      );
      return 0;
    }
    case "release-claim": {
      const path = args[0];
      if (!path) {
        process.stderr.write("agent-coord release-claim: missing <path>\n");
        return 2;
      }
      const before = writer.readHeartbeat(root, owner);
      const hb = writer.releaseClaim(root, owner, path);
      if (!hb) return 1;
      // Durability: the projector rebuilds files_touched by replaying the
      // permanent Edit/Write events, so a file-only release is silently
      // reverted by the next full replay. Emitting claim.release puts the
      // subtraction into the stream so every future replay honors it. Only
      // emit when the release actually removed a held path (idempotent
      // re-releases stay quiet).
      const heldBefore = before?.files_touched?.length ?? 0;
      const heldAfter = hb.files_touched?.length ?? 0;
      if (heldBefore > heldAfter) {
        await emitClaimRelease(root, owner, before ?? hb, path, "explicit");
      }
      process.stdout.write(
        `${JSON.stringify({ instance_id: owner, files_touched: hb.files_touched })}\n`,
      );
      return 0;
    }
    case "kill-heartbeat": {
      // Read held claims BEFORE the unlink so they can be released durably —
      // killing only the file leaves the claims resurrectable from the
      // permanent Edit/Write events on the next full replay (observed: a
      // 6-day-dead agent's claims returning after its heartbeat was killed).
      const before = writer.readHeartbeat(root, owner);
      const ok = writer.killHeartbeat(root, owner);
      if (ok && before) {
        for (const held of before.files_touched ?? []) {
          await emitClaimRelease(root, owner, before, held, "heal");
        }
      }
      process.stdout.write(`${JSON.stringify({ instance_id: owner, removed: ok })}\n`);
      return ok ? 0 : 1;
    }
    case "heal-pidmap": {
      const pidArg = args[0];
      const pid = pidArg ? Number(pidArg) : process.ppid;
      if (!Number.isFinite(pid)) {
        process.stderr.write(`agent-coord heal-pidmap: invalid pid ${pidArg}\n`);
        return 2;
      }
      writer.healPidmap(root, owner, pid);
      process.stdout.write(`${JSON.stringify({ instance_id: owner, pid })}\n`);
      return 0;
    }
    case "heal-heartbeat": {
      // harness arrives as a `--harness=<h>` flag (not positional) so the live
      // tool.pre_use heal and the manual `harn agents heal` path (which pass
      // different positional counts) can both supply it without arg-order
      // fragility. Positionals (sessionId, model) stay as-is once flags are
      // filtered out.
      const harness = args.find((a) => a.startsWith("--harness="))?.slice("--harness=".length);
      const positional = args.filter((a) => !a.startsWith("--"));
      const sessionId = positional[0];
      const model = positional[1];
      const hb = writer.healHeartbeat(root, owner, sessionId, model, harness);
      process.stdout.write(`${JSON.stringify({ instance_id: owner, recreated: !!hb })}\n`);
      return hb ? 0 : 1;
    }
    case "stamp-tool-activity": {
      const toolName = args[0] ?? "";
      const target = args.slice(1).join(" ");
      const hb = writer.stampToolActivity(root, owner, toolName, target);
      if (!hb) return 1;
      process.stdout.write(
        `${JSON.stringify({
          instance_id: owner,
          last_tool: hb.last_tool,
          last_tool_target: hb.last_tool_target,
        })}\n`,
      );
      return 0;
    }
    default:
      process.stderr.write(`agent-coord: unknown state action ${action}\n`);
      return 2;
  }
}

async function handleScratchAction(root: string, action: string, rest: string[]): Promise<number> {
  const scratch = await import("./state/scratch.ts");

  if (action === "append-scratch") {
    const [owner, category, ...bodyParts] = rest;
    const body = bodyParts.join(" ");
    if (!owner || !category || !body) {
      process.stderr.write("agent-coord append-scratch <instance_id> <category> <body>\n");
      return 2;
    }
    const result = scratch.appendScratch(root, owner, category, body);
    if (!result.ok) {
      process.stderr.write(`agent-coord append-scratch: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify({ instance_id: owner, category, path: result.path })}\n`,
    );
    return 0;
  }

  if (action === "edit-scratchpad") {
    const [owner, newBodyFile, ...summaryParts] = rest;
    const summary = summaryParts.join(" ");
    if (!owner || !newBodyFile) {
      process.stderr.write(
        "agent-coord edit-scratchpad <instance_id> <new-body-file> [<summary>]\n",
      );
      return 2;
    }
    if (!existsSync(newBodyFile)) {
      process.stderr.write(`agent-coord edit-scratchpad: file not found: ${newBodyFile}\n`);
      return 2;
    }
    const { readFileSync } = await import("node:fs");
    const newBody = readFileSync(newBodyFile, "utf8");
    const result = scratch.editScratchpad(root, owner, newBody, summary);
    if (!result.ok) {
      process.stderr.write(`agent-coord edit-scratchpad: ${result.reason}\n`);
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify({ instance_id: owner, path: result.path, archive_path: result.archivePath })}\n`,
    );
    return 0;
  }

  process.stderr.write(`agent-coord: unknown scratch action ${action}\n`);
  return 2;
}

async function handleCouncilAction(root: string, action: string, rest: string[]): Promise<number> {
  const council = await import("./state/council.ts");

  const [councilId, ...args] = rest;
  if (!councilId) {
    process.stderr.write(`agent-coord ${action}: missing <council_id>\n`);
    return 2;
  }

  switch (action) {
    case "council-advance": {
      const force = args.includes("--force");
      const result = council.advanceCouncil(root, councilId, { force });
      if (!result.ok) {
        process.stderr.write(`agent-coord council-advance: ${result.reason}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify({ council_id: councilId, ok: true })}\n`);
      return 0;
    }
    case "council-close": {
      const result = council.closeCouncil(root, councilId);
      if (!result.ok) {
        process.stderr.write(`agent-coord council-close: ${result.reason}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify({ council_id: councilId, ok: true })}\n`);
      return 0;
    }
    case "council-archive": {
      const result = council.archiveCouncil(root, councilId);
      if (!result.ok) {
        process.stderr.write(`agent-coord council-archive: ${result.reason}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify({ council_id: councilId, ok: true })}\n`);
      return 0;
    }
    case "council-unarchive": {
      const result = council.unarchiveCouncil(root, councilId);
      if (!result.ok) {
        process.stderr.write(`agent-coord council-unarchive: ${result.reason}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify({ council_id: councilId, ok: true })}\n`);
      return 0;
    }
    case "council-delete": {
      const result = council.deleteCouncil(root, councilId);
      if (!result.ok) {
        process.stderr.write(`agent-coord council-delete: ${result.reason}\n`);
        return 1;
      }
      process.stdout.write(`${JSON.stringify({ council_id: councilId, ok: true })}\n`);
      return 0;
    }
    case "council-set-steward": {
      const steward = args[0] ?? "";
      const stewardId = args[1] ?? "";
      const result = council.setCouncilSteward(root, councilId, steward, stewardId);
      if (!result.ok) {
        process.stderr.write(`agent-coord council-set-steward: ${result.reason}\n`);
        return 1;
      }
      process.stdout.write(
        `${JSON.stringify({ council_id: councilId, steward: steward || null, ok: true })}\n`,
      );
      return 0;
    }
  }

  process.stderr.write(`agent-coord: unknown council action ${action}\n`);
  return 2;
}

async function handleAssignName(root: string, rest: string[]): Promise<number> {
  const { assignName } = await import("./state/names.ts");
  const [owner, kindArg] = rest;
  if (!owner || !kindArg) {
    process.stderr.write("agent-coord assign-name <instance_id> <session|subagent|transient>\n");
    return 2;
  }
  if (kindArg !== "session" && kindArg !== "subagent" && kindArg !== "transient") {
    process.stderr.write(`agent-coord assign-name: invalid kind ${kindArg}\n`);
    return 2;
  }
  const name = assignName(root, owner, kindArg);
  process.stdout.write(`${JSON.stringify({ instance_id: owner, name, kind: kindArg })}\n`);
  return 0;
}

async function handlePostCommit(root: string): Promise<number> {
  const raw = await readStdin();
  let req: { owner?: string; prune?: string[] } = {};
  try {
    req = JSON.parse(raw);
  } catch {
    return 0;
  }
  const { groupUnclaim } = await import("./state/heartbeat-writer.ts");

  // Session-group-wide unclaim. `owner` is the parent's session_id which is
  // also the group key (parent + subagents share session_id). Each actual
  // removal also emits a durable claim.release event — the projector rebuilds
  // files_touched from the permanent Edit/Write events, so a file-only prune
  // would resurrect on the next replay.
  if (req.owner && Array.isArray(req.prune)) {
    for (const path of req.prune) {
      try {
        for (const hit of groupUnclaim(root, req.owner, path)) {
          await emitClaimRelease(root, hit.instance_id, hit, path, "commit");
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return 0;
}

async function handlePostCheckout(root: string, _rest: string[]): Promise<number> {
  const raw = await readStdin();
  let req: { owner?: string; removed?: string[] } = {};
  try {
    req = JSON.parse(raw);
  } catch {
    return 0;
  }
  const { groupUnclaim } = await import("./state/heartbeat-writer.ts");
  if (req.owner && Array.isArray(req.removed)) {
    for (const path of req.removed) {
      try {
        for (const hit of groupUnclaim(root, req.owner, path)) {
          await emitClaimRelease(root, hit.instance_id, hit, path, "checkout");
        }
      } catch {
        /* best-effort */
      }
    }
  }
  return 0;
}

async function handleShellMutationPaths(root: string, rest: string[]): Promise<number> {
  const { shellMutationPaths } = await import("./state/shell-mutation.ts");
  // --cmd "<string>" form; falls back to stdin if --cmd not supplied
  let cmd: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--cmd") {
      cmd = rest[i + 1];
      i++;
    }
  }
  if (cmd === undefined) cmd = await readStdin();
  const paths = shellMutationPaths(cmd, root);
  for (const p of paths) process.stdout.write(`${p}\n`);
  return 0;
}

async function handleShellMutationClaimLog(root: string, rest: string[]): Promise<number> {
  // Parse + log in one spawn, avoids per-line process spawn from the bash loop.
  // Usage:
  //   agent-coord shell-mutation-claim-log --cmd "<string>" --owner <id> --platform <p>
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1];
      if (val === undefined || val.startsWith("--")) {
        args[key] = "true";
      } else {
        args[key] = val;
        i++;
      }
    }
  }
  const cmd = args.cmd ?? "";
  if (!cmd) return 0;
  const platform = args.platform ?? "unknown";
  const owner = args.owner ?? null;
  const { shellMutationPaths } = await import("./state/shell-mutation.ts");
  const { emit } = await import("./events/emit.ts");
  const { readHeartbeat } = await import("./state/heartbeat-writer.ts");
  const paths = shellMutationPaths(cmd, root);
  const truncated = cmd.length > 80 ? cmd.slice(0, 80) : cmd;
  // Warn-only peer-shell-mutation signal. Formerly a SHELL_CLAIM_CANDIDATE line
  // in a log file; now a canonical decision.warn so the
  // signal survives in events.ndjson. (The blocking claim-conflict path is
  // separate: claim.conflict / verdict, and unaffected.)
  const harness = platform === "cursor" ? "cursor" : platform === "codex" ? "codex" : "claude-code";
  const hb = owner ? readHeartbeat(root, owner) : null;
  for (const p of paths) {
    try {
      emit(root, {
        event_type: "decision.warn",
        instance_id: owner ?? "unknown",
        session_id: hb?.session_id ?? owner ?? "unknown",
        harness,
        data: {
          rule: "shell_mutation_candidate",
          reason: `path=${p} cmd=${truncated} platform=${platform}`,
        },
      });
    } catch {
      /* telemetry only, never break the dispatcher */
    }
  }
  return 0;
}

async function handleStaleSweep(root: string, _rest: string[]): Promise<number> {
  const { staleSweep } = await import("./state/stale-sweep.ts");
  const result = staleSweep(root);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

async function handlePromptContext(root: string, rest: string[]): Promise<number> {
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1];
      if (val === undefined || val.startsWith("--")) {
        args[key] = "true";
      } else {
        args[key] = val;
        i++;
      }
    }
  }
  const instanceId = args.instance;
  const sessionId = args.session ?? instanceId;
  const agentName = args.name;
  const taskNudge = args["task-nudge"] === "true";
  if (!instanceId) {
    process.stderr.write(
      "agent-coord prompt-context --instance <id> [--session <id>] [--name <agent-name>] [--task-nudge]\n",
    );
    return 2;
  }
  const { renderPromptContext } = await import("./render/prompt-context.ts");
  const text = renderPromptContext({
    coordRoot: root,
    instanceId,
    sessionId: sessionId!,
    agentName,
    taskNudge,
  });
  process.stdout.write(text);
  return 0;
}

async function handleSessionContext(root: string, rest: string[]): Promise<number> {
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1];
      if (val === undefined || val.startsWith("--")) {
        args[key] = "true";
      } else {
        args[key] = val;
        i++;
      }
    }
  }
  const instanceId = args.instance;
  const sessionId = args.session ?? instanceId;
  const agentName = args.name;
  const platformLabel = args["platform-label"];
  if (!instanceId) {
    process.stderr.write(
      "agent-coord session-context --instance <id> [--session <id>] [--name <agent-name>] [--platform-label <label>]\n",
    );
    return 2;
  }
  const { renderSessionContext } = await import("./render/session-context.ts");
  const text = renderSessionContext({
    coordRoot: root,
    instanceId,
    sessionId: sessionId!,
    agentName,
    platformLabel,
  });
  process.stdout.write(text);
  return 0;
}

async function handleCodexReplay(root: string, rest: string[]): Promise<number> {
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1];
      if (val === undefined || val.startsWith("--")) {
        args[key] = "true";
      } else {
        args[key] = val;
        i++;
      }
    }
  }
  const jsonlPath = args.jsonl;
  const sessionId = args.session;
  const instanceId = args.owner ?? sessionId;
  const lastMsg = args["last-message"];
  if (!jsonlPath || !sessionId) {
    process.stderr.write(
      "agent-coord codex-replay --jsonl <path> --session <id> [--owner <id>] [--last-message <text>]\n",
    );
    return 2;
  }
  const { replayCodexJsonl } = await import("./codex-replay.ts");
  const result = replayCodexJsonl({
    coordRoot: root,
    jsonlPath,
    sessionId,
    instanceId: instanceId!,
    lastAssistantMessage: lastMsg,
  });
  process.stdout.write(`${JSON.stringify({ session_id: sessionId, emitted: result.emitted })}\n`);
  return 0;
}

async function handleResolveName(root: string, rest: string[]): Promise<number> {
  const { resolveName } = await import("./state/names.ts");
  const [owner, session] = rest;
  if (!owner) {
    process.stderr.write("agent-coord resolve-name <instance_id> [<session_id>]\n");
    return 2;
  }
  const resolved = resolveName(root, owner, session);
  if (!resolved) {
    process.stdout.write(`${JSON.stringify({ instance_id: owner, name: null, kind: null })}\n`);
    return 0;
  }
  process.stdout.write(
    `${JSON.stringify({ instance_id: owner, name: resolved.name, kind: resolved.kind })}\n`,
  );
  return 0;
}

async function handleEmitEvent(root: string, rest: string[]): Promise<number> {
  const { emitAndProject } = await import("./cli-emit.ts");
  const args: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = rest[i + 1];
      if (val === undefined || val.startsWith("--")) {
        args[key] = "true";
      } else {
        args[key] = val;
        i++;
      }
    }
  }

  const eventType = args.type;
  const instanceId = args.owner;
  const sessionId = args.session;
  const harness = args.harness as "claude-code" | "cursor" | "codex" | undefined;
  const dataJson = args["data-json"] ?? "{}";

  if (!eventType || !instanceId || !sessionId || !harness) {
    process.stderr.write(
      "agent-coord emit-event --type <T> --owner <id> --session <id> --harness <h> [--data-json '<json>']\n",
    );
    return 2;
  }

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(dataJson) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    } else {
      process.stderr.write("agent-coord emit-event: --data-json must encode an object\n");
      return 2;
    }
  } catch (err) {
    process.stderr.write(
      `agent-coord emit-event: invalid --data-json (${err instanceof Error ? err.message : String(err)})\n`,
    );
    return 2;
  }

  const result = emitAndProject(
    {
      event_type: eventType,
      instance_id: instanceId,
      session_id: sessionId,
      harness,
      turn_id: args["turn-id"],
      parent_session_id: args["parent-session-id"],
      parent_turn_id: args["parent-turn-id"],
      data,
    },
    { coordRoot: root },
  );

  if (!result) {
    process.stderr.write("agent-coord emit-event: emission failed\n");
    return 1;
  }

  process.stdout.write(`${JSON.stringify(result.envelope)}\n`);
  return 0;
}

async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const root = findCoordRoot(process.cwd());
  if (!root) return 0;

  if (subcommand === "verdict") {
    return handleVerdict(root);
  }

  if (subcommand === "project") {
    return handleProject(root, rest);
  }

  if (subcommand === "emit-event") {
    return handleEmitEvent(root, rest);
  }

  if (
    subcommand === "set-task" ||
    subcommand === "stamp-status-call" ||
    subcommand === "set-turn-summary" ||
    subcommand === "release-claim" ||
    subcommand === "kill-heartbeat" ||
    subcommand === "heal-pidmap" ||
    subcommand === "heal-heartbeat" ||
    subcommand === "stamp-tool-activity"
  ) {
    return handleStateAction(root, subcommand, rest);
  }

  if (subcommand === "append-scratch" || subcommand === "edit-scratchpad") {
    return handleScratchAction(root, subcommand, rest);
  }

  if (
    subcommand === "council-advance" ||
    subcommand === "council-close" ||
    subcommand === "council-archive" ||
    subcommand === "council-unarchive" ||
    subcommand === "council-delete" ||
    subcommand === "council-set-steward"
  ) {
    return handleCouncilAction(root, subcommand, rest);
  }

  if (subcommand === "assign-name") {
    return handleAssignName(root, rest);
  }

  if (subcommand === "resolve-name") {
    return handleResolveName(root, rest);
  }

  if (subcommand === "codex-replay") {
    return handleCodexReplay(root, rest);
  }

  if (subcommand === "stale-sweep") {
    return handleStaleSweep(root, rest);
  }

  if (subcommand === "session-context") {
    return handleSessionContext(root, rest);
  }

  if (subcommand === "prompt-context") {
    return handlePromptContext(root, rest);
  }

  if (subcommand === "shell-mutation-paths") {
    return handleShellMutationPaths(root, rest);
  }

  if (subcommand === "shell-mutation-claim-log") {
    return handleShellMutationClaimLog(root, rest);
  }

  if (subcommand === "post-commit") {
    return handlePostCommit(root);
  }

  if (subcommand === "post-checkout") {
    return handlePostCheckout(root, rest);
  }

  await logNoop(root, subcommand ?? "(none)", rest);
  // Phase 1/2: silent on stdout for unknown subcommands, exit 0. Existing
  // `harn agents …` callers keep working unchanged.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    try {
      const root = findCoordRoot(process.cwd());
      if (root) {
        const path = join(root, ".harnery", "debug", "agent-coord.errors.ndjson");
        appendFileSync(
          path,
          `${JSON.stringify({ ts: new Date().toISOString(), error: String(err) })}\n`,
        );
      }
    } catch {
      /* swallow */
    }
    process.exit(0);
  });
