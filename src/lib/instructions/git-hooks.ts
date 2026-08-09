/**
 * Git-hook side of ADR 0008's lifecycle contract: the coordination content of
 * a consumer's git hooks is machine-owned, exactly like the AGENTS.md block.
 * `init` installs/refreshes it, `deinit` removes it, `init --check` flags
 * drift.
 *
 * What lives in the hook file is deliberately tiny: a hash-versioned managed
 * region (# harnery:begin/end markers) that locates `agent-coord` and invokes
 * `git-hook <event>`. Every piece of actual behavior — staged collection,
 * submodule canonicalization, gitlink discrimination, verdict, claim pruning —
 * lives in harnery and upgrades with the package. The region only changes when
 * the invocation contract does, and then `init` re-splices it and `--check`
 * catches a stale copy. History's lesson (the first host carried ~200 lines of
 * coordination bash that decayed for months): logic in a host hook file is
 * logic outside the upgrade path.
 *
 * A hook file harnery created whole is deletable by `deinit` (nothing but the
 * shebang remains after the region is removed); a host-authored hook keeps all
 * host content and only loses the managed region.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  checkRegion,
  type ManagedStatus,
  regionBlock,
  removeRegion,
  spliceRegion,
} from "./splice.ts";

export const GIT_HOOK_EVENTS = ["pre-commit", "post-commit", "post-checkout"] as const;
export type GitHookEvent = (typeof GIT_HOOK_EVENTS)[number];

function regionName(event: GitHookEvent): string {
  return `git-hook-${event}`;
}

/**
 * The managed region body for one hook event. POSIX sh, `harnery_`-prefixed
 * variables (the region runs inside arbitrary host hook scripts), and a bin
 * lookup that covers both consumer layouts: git-submodule
 * (`<root>/harnery/bin/`) and npm (`<root>/node_modules/harnery/bin/`).
 *
 * pre-commit propagates a blocking exit code; post-commit / post-checkout are
 * best-effort and never fail the git operation.
 */
export function renderGitHookBody(event: GitHookEvent): string {
  const blocking = event === "pre-commit";
  const invoke = blocking
    ? `  "$harnery_hook_bin" git-hook ${event} "$@"\n` +
      `  harnery_hook_rc=$?\n` +
      `  [ "$harnery_hook_rc" -ne 0 ] && exit "$harnery_hook_rc"\n`
    : `  "$harnery_hook_bin" git-hook ${event} "$@" >/dev/null 2>&1 || true\n`;
  return (
    `# Coordination for this hook lives in harnery (agent-coord git-hook ${event});\n` +
    `# upgrading harnery upgrades the behavior. Managed region: do not edit by hand.\n` +
    `harnery_hook_root=$(git rev-parse --show-superproject-working-tree 2>/dev/null)\n` +
    `[ -n "$harnery_hook_root" ] || harnery_hook_root=$(git rev-parse --show-toplevel 2>/dev/null)\n` +
    `for harnery_hook_bin in "$harnery_hook_root/harnery/bin/agent-coord" "$harnery_hook_root/node_modules/harnery/bin/agent-coord"; do\n` +
    `  [ -x "$harnery_hook_bin" ] || continue\n` +
    invoke +
    `  break\n` +
    `done`
  );
}

/**
 * The effective hooks dir for the repo at `projectRoot`: honors
 * `core.hooksPath` (relative values resolve against the repo root) and
 * worktree layouts, because that's what `git rev-parse --git-path hooks`
 * reports. Null when `projectRoot` isn't a git repo.
 */
export function resolveHooksDir(projectRoot: string): string | null {
  const r = spawnSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  if (r.status !== 0) return null;
  const p = (r.stdout ?? "").trim();
  if (!p) return null;
  return isAbsolute(p) ? p : resolve(projectRoot, p);
}

export interface GitHooksResult {
  actions: string[];
  warnings: string[];
}

/** Install or refresh the managed region in each of the three hook files. */
export function applyGitHooks(projectRoot: string, opts: { dryRun?: boolean }): GitHooksResult {
  const dryRun = opts.dryRun === true;
  const actions: string[] = [];
  const warnings: string[] = [];
  const hooksDir = resolveHooksDir(projectRoot);
  if (!hooksDir) {
    warnings.push("not a git repository; skipped git-hook regions");
    return { actions, warnings };
  }

  if (!existsSync(hooksDir) && !dryRun) mkdirSync(hooksDir, { recursive: true });

  for (const event of GIT_HOOK_EVENTS) {
    const file = join(hooksDir, event);
    const body = renderGitHookBody(event);
    const region = regionName(event);
    const display = relative(projectRoot, file);

    if (!existsSync(file)) {
      if (dryRun) {
        actions.push(`+ would create ${display} (harnery-owned git hook)`);
        continue;
      }
      writeFileSync(file, `#!/bin/sh\n${regionBlock(region, body, "hash")}\n`);
      chmodSync(file, 0o755);
      actions.push(`+ created ${display} (harnery-owned git hook)`);
      continue;
    }

    const content = readFileSync(file, "utf8");
    const status = checkRegion(content, region, body, "hash");
    if (status === "fresh") {
      actions.push(`· ${display} git-hook region current`);
      continue;
    }

    if (status === "stale") {
      const spliced = spliceRegion(content, region, body, "hash");
      if (dryRun) actions.push(`+ would refresh stale git-hook region in ${display}`);
      else {
        writeFileSync(file, spliced.text);
        actions.push(`+ refreshed stale git-hook region in ${display}`);
      }
      continue;
    }

    // Missing from an existing, host-authored hook: insert right after the
    // shebang. Coordination runs first on purpose — an agent should hear
    // "this commit is blocked by a peer's claim" before paying for the host's
    // typecheck/lint checks, and post-checkout's claim release must beat any
    // host short-circuit below it.
    if (dryRun) {
      actions.push(`+ would insert git-hook region into ${display} (after shebang)`);
      continue;
    }
    const block = regionBlock(region, body, "hash");
    let text: string;
    if (content.startsWith("#!")) {
      const nl = content.indexOf("\n");
      text = `${content.slice(0, nl + 1)}\n${block}\n${content.slice(nl + 1)}`;
    } else {
      text = `${block}\n\n${content}`;
    }
    writeFileSync(file, text);
    actions.push(`+ inserted git-hook region into ${display} (after shebang)`);
  }

  return { actions, warnings };
}

/**
 * Has this project adopted harnery-managed git hooks at all? True when any of
 * the three hook files carries a managed region. Adoption is the gate between
 * "never installed" (a consumer that upgraded but hasn't opted in — not drift,
 * `--check` stays green, `doctor` nudges) and "decayed" (a region existed and
 * is now stale or partially deleted — drift, `--check` goes red).
 */
export function gitHooksInstalled(projectRoot: string): boolean {
  const hooksDir = resolveHooksDir(projectRoot);
  if (!hooksDir) return false;
  for (const event of GIT_HOOK_EVENTS) {
    const file = join(hooksDir, event);
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file, "utf8").includes(`harnery:begin ${regionName(event)}`)) return true;
    } catch {
      /* unreadable file counts as absent */
    }
  }
  return false;
}

/**
 * Drift report for `init --check`: per-hook managed-region freshness. A
 * project that never adopted git hooks reports fresh — an upgrade must not
 * turn a consumer's CI red for a feature they haven't installed.
 */
export function checkGitHooks(projectRoot: string): { status: ManagedStatus; issues: string[] } {
  const issues: string[] = [];
  let worst: ManagedStatus = "fresh";
  const hooksDir = resolveHooksDir(projectRoot);
  if (!hooksDir) return { status: "fresh", issues };
  if (!gitHooksInstalled(projectRoot)) return { status: "fresh", issues };

  for (const event of GIT_HOOK_EVENTS) {
    const file = join(hooksDir, event);
    const display = relative(projectRoot, file);
    if (!existsSync(file)) {
      issues.push(`${display}: missing (run init to create the harnery git hook)`);
      worst = "missing";
      continue;
    }
    const status = checkRegion(
      readFileSync(file, "utf8"),
      regionName(event),
      renderGitHookBody(event),
      "hash",
    );
    if (status !== "fresh") {
      issues.push(`${display}: git-hook region ${status} (re-run init to refresh)`);
      if (worst === "fresh") worst = status;
    }
  }
  return { status: worst, issues };
}

/**
 * Remove the managed region from each hook. A file that was harnery-created
 * whole (nothing but a shebang left) is deleted; host-authored hooks keep
 * every host line.
 */
export function removeGitHooks(projectRoot: string, opts: { dryRun?: boolean }): GitHooksResult {
  const dryRun = opts.dryRun === true;
  const actions: string[] = [];
  const warnings: string[] = [];
  const hooksDir = resolveHooksDir(projectRoot);
  if (!hooksDir) return { actions, warnings };

  for (const event of GIT_HOOK_EVENTS) {
    const file = join(hooksDir, event);
    if (!existsSync(file)) continue;
    const display = relative(projectRoot, file);
    const content = readFileSync(file, "utf8");
    const { text, removed } = removeRegion(content, regionName(event), "hash");
    if (!removed) continue;

    const residue = text.replace(/^#![^\n]*\n?/, "").trim();
    if (residue === "") {
      if (dryRun) actions.push(`+ would remove ${display} (was harnery-owned)`);
      else {
        rmSync(file);
        actions.push(`+ removed ${display} (was harnery-owned)`);
      }
    } else if (dryRun) {
      actions.push(`+ would remove git-hook region from ${display} (host content kept)`);
    } else {
      writeFileSync(file, text);
      actions.push(`+ removed git-hook region from ${display} (host content kept)`);
    }
  }
  return { actions, warnings };
}
