/**
 * `harn init`: idempotently wire harnery into a project.
 *
 * Two things a fresh consumer otherwise has to know to do by hand (both silent
 * if skipped):
 *   1. Create the `.harnery/` coord root; without it `findCoordRoot` returns
 *      null and every hook no-ops forever.
 *   2. Register the agent-hook entries in the adapter settings file.
 *
 * Wires whichever adapter `--adapter` names (Claude Code `.claude/settings.json`,
 * Cursor `.cursor/hooks.json`, or Codex `.codex/hooks.json`): the per-adapter
 * file path, event list, and hook-entry shape all come from ADAPTER_SPECS.
 *
 * `harn init` does both, non-destructively: it merges hook entries into an
 * existing settings file (preserving any other hooks) and skips entries that are
 * already wired, so it's safe to re-run. `--dry-run` previews without writing.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { DEFAULT_BIN_NAME, pinnedBinName, stripJsonComments } from "../core/config.ts";
import { canonicalJsonV3 } from "../core/events/v3/canonical.ts";
import { ADAPTER_CAPABILITY_PROFILES_V3 } from "../core/events/v3/capabilities.ts";
import type { EventV3ControlState } from "../core/events/v3/control.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "../core/events/v3/generated.ts";
import {
  initializeEventLedgerV3,
  readEventV3ControlState,
  sha256V3,
} from "../core/events/v3/index.ts";
import { liveEventV3BuildId } from "../core/events/v3/live-routing.ts";
import { ADAPTER_SPECS, type AdapterId, type AdapterSpec } from "../core/hooks/adapter/events.ts";
import {
  agentHookPathForProject,
  commandWiresSubcommand,
  diffWiring,
  groupCommands,
  type HookGroup,
  hookCommand,
  isAgentHookCommand,
  makeEntry,
  type SettingsFile,
} from "../core/hooks/adapter/wiring.ts";
import {
  type ApplyResult,
  applyInstructions,
  checkInstructions,
} from "../lib/instructions/apply.ts";
import { applyGitHooks, checkGitHooks } from "../lib/instructions/git-hooks.ts";
import { HostAddendumError } from "../lib/instructions/host-addendum.ts";

// This file is src/commands/init.ts → harnery package root is two levels up.
const HARNERY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface InitOpts {
  adapter: string;
  dryRun?: boolean;
  check?: boolean;
  projectRoot?: string;
}

export function registerInitCommand(program: Command, emit: EmitContext, binName?: string): void {
  program
    .command("init")
    .description(
      "Bootstrap harnery in this project: create .harnery/, wire the adapter " +
        "hooks, and inject the agent-facing instructions block + skills " +
        "(idempotent; safe to re-run). Use --dry-run to preview, --check to " +
        "report drift without writing (exit 0 fresh / 2 drift / 1 error).",
    )
    .option("--adapter <id>", "claude-code | cursor | codex", "claude-code")
    .option("--dry-run", "Show what would change without writing")
    .option("--check", "Report instructions/skills drift without writing; exit 0/2/1")
    .option("--project-root <path>", "Project root (default: git toplevel, else cwd)")
    .action((opts: InitOpts) => {
      const adapter = opts.adapter as AdapterId;
      const spec = ADAPTER_SPECS[adapter];
      if (!spec) {
        emit.text(`Unknown adapter '${opts.adapter}'. Expected: claude-code | cursor | codex.`);
        emit.setExitCode(1);
        return;
      }

      const projectRoot = resolve(opts.projectRoot ?? gitTopLevel() ?? process.cwd());
      // A binName already pinned in this project's config.jsonc beats the
      // invoking CLI's name: the pin is a committed, deliberate declaration;
      // the invoking bin is circumstantial (any embedding host's CLI can run
      // init inside any checkout). Without this, re-running init from a host
      // CLI re-stamps the host's name into committed agent-facing surfaces.
      const bin = pinnedBinName(projectRoot) ?? (binName?.trim() ? binName : DEFAULT_BIN_NAME);

      // ── --check: read-only drift report on every init-managed surface ─────
      if (opts.check === true) {
        const { status, issues } = checkInstructions(projectRoot, { binName: bin, adapter });
        let hookCheckError = false;
        let hookDrift = false;
        const settingsPath = resolve(projectRoot, spec.settingsFile);
        const agentHook = agentHookPathForProject(projectRoot, HARNERY_ROOT);
        if (!existsSync(settingsPath)) {
          hookDrift = true;
          issues.push(`${spec.settingsFile}: missing (re-run init)`);
        } else {
          try {
            const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
            const hookDiff = diffWiring(settings, spec, { agentHookPath: agentHook, adapter });
            hookDrift =
              hookDiff.missing.length > 0 ||
              hookDiff.stale.length > 0 ||
              hookDiff.duplicates.length > 0 ||
              hookDiff.misplaced.length > 0 ||
              hookDiff.orphans.length > 0 ||
              hookDiff.invalidTopLevelKeys.length > 0 ||
              hookDiff.invalidEventKeys.length > 0;
            if (hookDiff.missing.length > 0) {
              issues.push(
                `${spec.settingsFile}: missing hooks (${hookDiff.missing.map((e) => e.settingsKey).join(", ")})`,
              );
            }
            if (hookDiff.stale.length > 0) {
              issues.push(
                `${spec.settingsFile}: stale hook commands (${hookDiff.stale.map((e) => e.settingsKey).join(", ")})`,
              );
            }
            if (hookDiff.duplicates.length > 0) {
              issues.push(
                `${spec.settingsFile}: duplicate hooks (${hookDiff.duplicates.map((e) => e.settingsKey).join(", ")})`,
              );
            }
            if (hookDiff.misplaced.length > 0) {
              issues.push(
                `${spec.settingsFile}: hooks under the wrong event (${hookDiff.misplaced.map((e) => e.subcommand).join(", ")})`,
              );
            }
            if (hookDiff.orphans.length > 0) {
              issues.push(`${spec.settingsFile}: obsolete hooks (${hookDiff.orphans.join(", ")})`);
            }
            if (hookDiff.invalidTopLevelKeys.length > 0) {
              issues.push(
                `${spec.settingsFile}: invalid fields (${hookDiff.invalidTopLevelKeys.join(", ")})`,
              );
            }
            if (hookDiff.invalidEventKeys.length > 0) {
              issues.push(
                `${spec.settingsFile}: unsupported events (${hookDiff.invalidEventKeys.join(", ")})`,
              );
            }
          } catch (error) {
            hookCheckError = true;
            issues.push(`${spec.settingsFile}: invalid JSON (${(error as Error).message})`);
          }
        }
        const gitHooks = checkGitHooks(projectRoot);
        if (gitHooks.status !== "fresh") issues.push(...gitHooks.issues);
        const ledger = readEventV3ControlState(projectRoot);
        if (ledger.state !== "active") issues.push(`event ledger V3 is ${ledger.state}`);
        const ledgerRuntimeIssues = eventLedgerV3RuntimeIssues(ledger, gitBuild(HARNERY_ROOT));
        if (ledgerRuntimeIssues.length > 0) {
          issues.push(`event ledger V3 is runtime-stale (${ledgerRuntimeIssues.join(", ")})`);
        }
        const merged =
          status === "error" || hookCheckError
            ? "error"
            : hookDrift ||
                gitHooks.status !== "fresh" ||
                ledger.state !== "active" ||
                ledgerRuntimeIssues.length > 0
              ? "drift"
              : status;
        const head =
          merged === "fresh"
            ? "harn init --check: hooks + instructions + skills + event ledger V3 are current"
            : merged === "drift"
              ? "harn init --check: drift found (re-run `init` to refresh)"
              : "harn init --check: error";
        const lines = issues.length ? `\n${issues.map((i) => `  ✗ ${i}`).join("\n")}` : "";
        emit.text(`${head}${lines}`);
        emit.setExitCode(merged === "fresh" ? 0 : merged === "drift" ? 2 : 1);
        return;
      }

      const dryRun = opts.dryRun === true;
      const actions: string[] = [];

      // ── 1. coord root ──────────────────────────────────────────────────────
      const coordDir = resolve(projectRoot, ".harnery");
      if (existsSync(coordDir)) {
        actions.push("· .harnery/ already exists");
      } else if (dryRun) {
        actions.push("+ would create .harnery/ (+ .harnery/.gitignore)");
      } else {
        mkdirSync(coordDir, { recursive: true });
        // Runtime state is machine-local; don't let consumers commit heartbeats.
        writeFileSync(resolve(coordDir, ".gitignore"), "*\n!.gitignore\n");
        actions.push("+ created .harnery/ (+ .harnery/.gitignore)");
      }

      // ── 1b. stamp the host bin name ────────────────────────────────────────
      // The coord binaries (agent-hook/agent-coord) and web UI run as harnery
      // itself, so they can't see a consumer CLI's name; they read it back from
      // config.jsonc. Standalone `harn` is the resolver's default, so only a
      // consumer (bin ≠ "harn") needs the stamp. `bin` already honors an
      // existing pin, so this never overwrites a deliberate config value.
      if (bin !== DEFAULT_BIN_NAME) {
        const configPath = resolve(coordDir, "config.jsonc");
        const stamp = stampBinName(configPath, bin, dryRun);
        if (stamp) actions.push(stamp);
      }

      // ── 1c. workflow billing default ───────────────────────────────────────
      // Every init'd project gets `workflow.subscriptionOnly: true`: workflow
      // children ride the logged-in (subscription) adapter auth, and the pin
      // makes per-token API billing structurally impossible unless the project
      // deliberately flips it. A committed `workflow` key of any shape is a
      // deliberate choice and is never touched.
      {
        const stamp = stampWorkflowDefaults(resolve(coordDir, "config.jsonc"), dryRun);
        if (stamp) actions.push(stamp);
      }

      // ── 1d. universal V3 event ledger ────────────────────────────────────
      if (dryRun) {
        const ledger = readEventV3ControlState(projectRoot);
        const runtimeIssues = eventLedgerV3RuntimeIssues(ledger, gitBuild(HARNERY_ROOT));
        actions.push(
          ledger.state === "active" && runtimeIssues.length === 0
            ? "· event ledger V3 is active"
            : ledger.state === "active"
              ? `+ would refresh event ledger V3 runtime profile (${runtimeIssues.join(", ")})`
              : `+ would initialize event ledger V3 (current state: ${ledger.state})`,
        );
      } else {
        const harneryBuild = gitBuild(HARNERY_ROOT);
        const ledgerBefore = readEventV3ControlState(projectRoot);
        const runtimeIssues = eventLedgerV3RuntimeIssues(ledgerBefore, harneryBuild);
        const initialized = initializeEventLedgerV3({
          coordRoot: projectRoot,
          harneryBuild,
          hostBuild: gitBuild(projectRoot),
          configDigest: digestConfig(resolve(coordDir, "config.jsonc")),
          approvalRecordId: "harnery-init-v3-universal",
          forceNewEpoch: runtimeIssues.length > 0,
        });
        actions.push(
          initialized.archived_epoch
            ? `+ refreshed event ledger V3 runtime profile (${runtimeIssues.join(", ")}); archived the prior epoch intact`
            : initialized.initialized
              ? "+ initialized event ledger V3"
              : "· event ledger V3 already active",
        );
      }

      // ── 2. adapter hooks ───────────────────────────────────────────────────
      const settingsPath = resolve(projectRoot, spec.settingsFile);
      const agentHook = agentHookPathForProject(projectRoot, HARNERY_ROOT);

      let settings: SettingsFile;
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
        } catch (err) {
          emit.text(
            `✗ ${rel(projectRoot, settingsPath)} exists but isn't valid JSON; refusing to ` +
              `overwrite. Fix it and re-run.\n  (${(err as Error).message})`,
          );
          emit.setExitCode(1);
          return;
        }
      } else {
        settings = {};
      }
      const { wired, already, removed, upgraded } = wireHooks(settings, spec, agentHook, adapter);

      if (wired === 0 && removed === 0 && upgraded === 0) {
        actions.push(
          `· all ${spec.events.length} ${adapter} hooks already wired in ${rel(projectRoot, settingsPath)}`,
        );
      } else if (dryRun) {
        actions.push(
          `+ would wire ${wired} hook(s), upgrade ${upgraded} stale command(s), and remove ` +
            `${removed} obsolete/duplicate command(s) in ${rel(projectRoot, settingsPath)} (${already} already present)`,
        );
      } else {
        mkdirSync(dirname(settingsPath), { recursive: true });
        writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
        actions.push(
          `+ wired ${wired} hook(s), upgraded ${upgraded} stale command(s), and removed ` +
            `${removed} obsolete/duplicate command(s) in ${rel(projectRoot, settingsPath)} (${already} already present)`,
        );
      }
      const authorizationReview = codexHookReviewAction(adapter);
      if (authorizationReview) actions.push(authorizationReview);

      // ── 3. agent-facing instructions block + skills ────────────────────────
      // A misconfigured host addendum aborts here rather than half-writing: the
      // apply step validates the configured source before it touches a file, so
      // a bad path leaves the repo exactly as it found it.
      let applied: ApplyResult;
      try {
        applied = applyInstructions(projectRoot, { binName: bin, adapter, dryRun });
      } catch (err) {
        if (!(err instanceof HostAddendumError)) throw err;
        emit.text(`${bin} init: ${err.message}`);
        emit.setExitCode(1);
        return;
      }
      actions.push(...applied.actions);

      // ── 4. git-hook managed regions ────────────────────────────────────────
      // Same lifecycle contract as the instructions block: the coordination
      // content of the consumer's git hooks is machine-owned and versioned;
      // everything else in those files belongs to the host.
      const gitHooks = applyGitHooks(projectRoot, { dryRun });
      actions.push(...gitHooks.actions);

      emit.text(render(projectRoot, dryRun, actions, [...applied.warnings, ...gitHooks.warnings]));
    });
}

function gitBuild(root: string): string {
  const result = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5000,
  });
  const commit = result.status === 0 ? result.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(commit)
    ? commit
    : createHash("sha256").update(resolve(root)).digest("hex");
}

function digestConfig(path: string): `sha256:${string}` {
  return sha256V3(existsSync(path) ? readFileSync(path) : Buffer.from("{}\n"));
}

/**
 * Runtime gates bound into an immutable V3 epoch. `init` is the explicit
 * upgrade boundary: when code or capability profiles change, it archives the
 * old epoch intact and activates a compatible one instead of letting upgraded
 * hooks fail closed against stale approvals.
 */
export function eventLedgerV3RuntimeIssues(
  control: EventV3ControlState,
  harneryBuild: string,
): string[] {
  if (control.state !== "active") return [];
  const issues: string[] = [];
  const profile = control.genesis.profile;
  if (profile.initial_schema_digest !== EVENT_V3_SCHEMA_DIGEST) issues.push("schema digest");
  if (profile.contract_source_digest !== EVENT_V3_SCHEMA_DIGEST) issues.push("contract digest");
  if (!profile.producer_build_ids.includes(liveEventV3BuildId(harneryBuild))) {
    issues.push("producer build");
  }
  const expectedCapabilities = Object.values(ADAPTER_CAPABILITY_PROFILES_V3).map((value) =>
    sha256V3(canonicalJsonV3(value)),
  );
  if (
    expectedCapabilities.some(
      (digest) => !profile.adapter_capability_profile_digests.includes(digest),
    )
  ) {
    issues.push("adapter capabilities");
  }
  return issues;
}

export function codexHookReviewAction(adapter: AdapterId): string | null {
  if (adapter !== "codex") return null;
  return (
    "! Codex authorizes hook commands separately. Before starting work, review them in " +
    "the terminal UI with `/hooks` or in Codex Desktop under Settings > Hooks. " +
    "After approval, start a fresh task so SessionStart can run."
  );
}

/**
 * Merge agent-hook entries into a adapter settings object in place, idempotently.
 * Preserves every existing hook; rewrites events already wired to
 * `agent-hook <subcommand>` when their command string is stale (e.g. an older
 * harnery wired a bare relative path). Honors the adapter's entry shape
 * (Claude/Codex nest under an inner `hooks` array; Cursor uses a flat
 * `{ command }`) and ensures the root `version` key when the adapter requires
 * one. Pure (no fs/git) so it's unit-testable.
 *
 * Token-aware matching keeps `stop` from matching `stop-failure`.
 */
export function wireHooks(
  settings: SettingsFile,
  spec: AdapterSpec,
  agentHookPath: string,
  adapter: AdapterId,
): { wired: number; already: number; removed: number; upgraded: number } {
  if (spec.rootVersion !== undefined && settings.version === undefined) {
    settings.version = spec.rootVersion;
  }
  if (!settings.hooks) settings.hooks = {};
  let wired = 0;
  let already = 0;
  let removed = 0;
  let upgraded = 0;
  for (const { subcommand } of spec.legacyEvents ?? []) {
    for (const settingsKey of Object.keys(settings.hooks)) {
      removed += removeCommandsFromKey(settings, settingsKey, (command) =>
        commandWiresSubcommand(command, subcommand),
      );
    }
  }
  for (const { settingsKey, subcommand } of spec.events) {
    const command = hookCommand(spec, agentHookPath, subcommand, adapter);
    let present = false;
    for (const key of Object.keys(settings.hooks)) {
      if (key === settingsKey) continue;
      removed += removeCommandsFromKey(settings, key, (candidate) =>
        commandWiresSubcommand(candidate, subcommand),
      );
    }
    const groups = settings.hooks[settingsKey] ?? [];
    const nextGroups: HookGroup[] = [];
    for (const group of groups) {
      const normalized = normalizeEventGroup(group, subcommand, command, present);
      if (normalized.found && !present) present = true;
      upgraded += normalized.upgraded;
      removed += normalized.removed;
      if (normalized.group) nextGroups.push(normalized.group);
    }
    if (nextGroups.length > 0) settings.hooks[settingsKey] = nextGroups;
    else delete settings.hooks[settingsKey];
    if (present) {
      already++;
      continue;
    }
    const current = settings.hooks[settingsKey] ?? [];
    current.push(makeEntry(spec.entryShape, command));
    settings.hooks[settingsKey] = current;
    wired++;
  }
  return { wired, already, removed, upgraded };
}

/**
 * The canonical hook command for one event. When the adapter exports a
 * project-dir env var to hook processes (Claude Code's CLAUDE_PROJECT_DIR),
 * anchor the agent-hook path on it: hook processes inherit the session
 * shell's cwd, which follows `cd` away from the project root — a bare
 * relative path silently fails to spawn from there (no events, no image
 * capture, no guards). `:-.` keeps the command working on adapter versions
 * that don't set the var. Only the env expansion is quoted so the
 * `agent-hook <subcommand> ` wiring match stays byte-identical.
 */
function normalizeEventGroup(
  group: HookGroup,
  subcommand: string,
  canonical: string,
  alreadyFound: boolean,
): { group: HookGroup | null; found: boolean; upgraded: number; removed: number } {
  let found = false;
  let upgraded = 0;
  let removed = 0;
  if ("command" in group && typeof group.command === "string") {
    if (commandWiresSubcommand(group.command, subcommand)) {
      if (alreadyFound) return { group: null, found: true, upgraded: 0, removed: 1 };
      found = true;
      if (group.command !== canonical) {
        group.command = canonical;
        upgraded++;
      }
    }
  }
  if ("hooks" in group && Array.isArray(group.hooks)) {
    const kept = [] as typeof group.hooks;
    for (const hook of group.hooks) {
      if (typeof hook.command !== "string" || !commandWiresSubcommand(hook.command, subcommand)) {
        kept.push(hook);
        continue;
      }
      if (alreadyFound || found) {
        removed++;
        continue;
      }
      found = true;
      if (hook.command !== canonical) {
        hook.command = canonical;
        upgraded++;
      }
      kept.push(hook);
    }
    group.hooks = kept;
    if (group.hooks.length === 0) return { group: null, found, upgraded, removed };
  }
  return { group, found, upgraded, removed };
}

/** Remove matching command handlers while preserving unrelated handlers in a mixed group. */
function removeCommandsFromKey(
  settings: SettingsFile,
  settingsKey: string,
  predicate: (command: string) => boolean,
): number {
  const groups = settings.hooks?.[settingsKey];
  if (!Array.isArray(groups)) return 0;
  let removed = 0;
  const kept: HookGroup[] = [];
  for (const group of groups) {
    if ("command" in group && typeof group.command === "string") {
      if (predicate(group.command)) removed++;
      else kept.push(group);
      continue;
    }
    if ("hooks" in group && Array.isArray(group.hooks)) {
      const handlers = group.hooks.filter((hook) => {
        if (typeof hook.command !== "string" || !predicate(hook.command)) return true;
        removed++;
        return false;
      });
      group.hooks = handlers;
      if (handlers.length > 0) kept.push(group);
      continue;
    }
    kept.push(group);
  }
  if (kept.length === 0) delete settings.hooks?.[settingsKey];
  else settings.hooks![settingsKey] = kept;
  return removed;
}

/**
 * Inverse of {@link wireHooks}: strip every harnery-owned hook entry from a
 * settings object in place, idempotently. A hook is "harnery's" when its command
 * contains `agent-hook ` (the trailing space matches `agent-hook <subcommand>`),
 * so any non-harnery hook the consumer added is preserved. Emptied
 * `hooks[settingsKey]` arrays are dropped; an emptied `hooks` object is dropped
 * entirely. Adapter-agnostic (scans every key) so it removes entries left by any
 * adapter. Pure (no fs) so it's unit-testable. Returns the count removed and the
 * count of non-harnery hooks left behind.
 */
export function unwireHooks(settings: SettingsFile): { removed: number; remaining: number } {
  if (!settings.hooks || typeof settings.hooks !== "object") return { removed: 0, remaining: 0 };
  let removed = 0;
  for (const key of Object.keys(settings.hooks)) {
    removed += removeCommandsFromKey(settings, key, isAgentHookCommand);
  }
  let remaining = 0;
  for (const groups of Object.values(settings.hooks)) {
    if (Array.isArray(groups)) remaining += groups.flatMap(groupCommands).length;
  }
  // drop the now-empty hooks object so callers see a clean shape
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return { removed, remaining };
}

/**
 * Idempotently record `binName` in `.harnery/config.jsonc`, preserving any
 * existing JSONC comments and the `files` section. Returns an action line, or
 * null when nothing changed. Three cases:
 *   - file absent → write a minimal commented stub;
 *   - `binName` already present + matching → no-op;
 *   - present-but-different value → comment-safe in-place value swap;
 *   - key absent → splice it in as the first key (comment-safe).
 */
export function stampBinName(configPath: string, binName: string, dryRun: boolean): string | null {
  const rel = (p: string) => relative(dirname(dirname(configPath)), p) || p;
  const quoted = JSON.stringify(binName);

  if (!existsSync(configPath)) {
    if (dryRun) return `+ would stamp binName "${binName}" into ${rel(configPath)}`;
    writeFileSync(
      configPath,
      `{\n  // Host CLI bin name, surfaced in agent-facing prompts + nudges.\n  "binName": ${quoted}\n}\n`,
    );
    return `+ stamped binName "${binName}" into ${rel(configPath)}`;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  let parsed: { binName?: unknown } & Record<string, unknown>;
  try {
    parsed = (JSON.parse(stripJsonComments(raw)) as typeof parsed) ?? {};
  } catch {
    // Unparseable config: don't clobber it; leave the bin name to env/manual fix.
    return `· ${rel(configPath)} isn't valid JSONC; skipped binName stamp`;
  }

  if (parsed.binName === binName) return null;

  if (typeof parsed.binName === "string") {
    // Existing value differs; swap it in place (keeps comments + layout).
    const next = raw.replace(/("binName"\s*:\s*)"(?:[^"\\]|\\.)*"/, `$1${quoted}`);
    if (dryRun) return `~ would update binName → "${binName}" in ${rel(configPath)}`;
    writeFileSync(configPath, next);
    return `~ updated binName → "${binName}" in ${rel(configPath)}`;
  }

  // No binName key yet; splice it as the first key.
  const keys = Object.keys(parsed);
  let next: string;
  if (keys.length === 0) {
    next = `{\n  "binName": ${quoted}\n}\n`;
  } else {
    // Insert after the first structural `{` (skipping leading ws + comments).
    const at = firstBraceIndex(raw);
    if (at < 0) return `· ${rel(configPath)} has no object literal; skipped binName stamp`;
    next = `${raw.slice(0, at + 1)}\n  "binName": ${quoted},${raw.slice(at + 1)}`;
  }
  if (dryRun) return `+ would add binName "${binName}" to ${rel(configPath)}`;
  writeFileSync(configPath, next);
  return `+ added binName "${binName}" to ${rel(configPath)}`;
}

/** The commented workflow-billing default block init stamps into config.jsonc. */
const WORKFLOW_DEFAULT_BLOCK =
  `  // Workflow children ride the logged-in (subscription) adapter auth; this pin\n` +
  `  // scrubs API-key vars from child envs so runs can never bill per-token rates.\n` +
  `  // Key-only hosts (CI): set false, or HARNERY_WORKFLOW_SUBSCRIPTION_ONLY=0.\n` +
  `  "workflow": { "subscriptionOnly": true }`;

/**
 * Idempotently pin `workflow.subscriptionOnly: true` in `.harnery/config.jsonc`
 * (see `workflowSubscriptionOnly()` in core/config.ts and the `workflow run`
 * billing safeguards). Same comment-preserving discipline as `stampBinName`.
 * A `workflow` key of ANY shape (including `subscriptionOnly: false`) is a
 * deliberate project choice and is left alone.
 */
export function stampWorkflowDefaults(configPath: string, dryRun: boolean): string | null {
  const rel = (p: string) => relative(dirname(dirname(configPath)), p) || p;

  if (!existsSync(configPath)) {
    if (dryRun) return `+ would pin workflow.subscriptionOnly in ${rel(configPath)}`;
    writeFileSync(configPath, `{\n${WORKFLOW_DEFAULT_BLOCK}\n}\n`);
    return `+ pinned workflow.subscriptionOnly: true in ${rel(configPath)}`;
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    return null;
  }
  let parsed: { workflow?: unknown } & Record<string, unknown>;
  try {
    parsed = (JSON.parse(stripJsonComments(raw)) as typeof parsed) ?? {};
  } catch {
    return `· ${rel(configPath)} isn't valid JSONC; skipped workflow.subscriptionOnly pin`;
  }

  if ("workflow" in parsed) return null; // deliberate config; never touch

  const at = firstBraceIndex(raw);
  if (at < 0) return `· ${rel(configPath)} has no object literal; skipped workflow pin`;
  const keys = Object.keys(parsed);
  const next =
    keys.length === 0
      ? `{\n${WORKFLOW_DEFAULT_BLOCK}\n}\n`
      : `${raw.slice(0, at + 1)}\n${WORKFLOW_DEFAULT_BLOCK},${raw.slice(at + 1)}`;
  if (dryRun) return `+ would pin workflow.subscriptionOnly in ${rel(configPath)}`;
  writeFileSync(configPath, next);
  return `+ pinned workflow.subscriptionOnly: true in ${rel(configPath)}`;
}

/** Index of the first structural `{`, skipping leading whitespace + comments. */
function firstBraceIndex(raw: string): number {
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
    } else if (ch === "/" && raw[i + 1] === "/") {
      while (i < raw.length && raw[i] !== "\n") i++;
    } else if (ch === "/" && raw[i + 1] === "*") {
      i += 2;
      while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
      i += 2;
    } else if (ch === "{") {
      return i;
    } else {
      return -1;
    }
  }
  return -1;
}

function render(
  projectRoot: string,
  dryRun: boolean,
  actions: string[],
  warnings: string[] = [],
): string {
  const head = dryRun ? "harn init (dry run): no changes written" : "harn init";
  const warnBlock = warnings.length ? `\n${warnings.map((w) => `  ! ${w}`).join("\n")}` : "";
  const tail = dryRun
    ? "\nRe-run without --dry-run to apply."
    : "\nDone. Start a session and check `harn agents whoami`.";
  return `${head}\n  root: ${projectRoot}\n${actions.map((a) => `  ${a}`).join("\n")}${warnBlock}${tail}`;
}

function gitTopLevel(): string | null {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  const out = r.status === 0 ? r.stdout.trim() : "";
  return out || null;
}

function rel(root: string, p: string): string {
  const r = relative(root, p);
  return r || p;
}
