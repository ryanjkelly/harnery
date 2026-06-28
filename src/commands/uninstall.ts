/**
 * `harn uninstall`: reverse what `harn init` wired into a project.
 *
 * `init` makes two kinds of change outside the harnery package:
 *   1. Merges `agent-hook` entries into the harness settings file
 *      (Claude Code `.claude/settings.json`, Cursor `.cursor/hooks.json`, or
 *      Codex `.codex/hooks.json`).
 *   2. Creates the `.harnery/` coord root (runtime state: events, councils,
 *      identities, scratch) and stamps the host bin name into
 *      `.harnery/config.jsonc`.
 *
 * `uninstall` undoes (1) by default: it removes only harnery's hook entries from
 * the settings file, preserving any other hooks the consumer added, and deletes
 * the settings file outright when it's left harnery-only. It does NOT touch the
 * `.harnery/` coord root unless `--purge-state` is passed, because that directory
 * holds session history a consumer may want to keep. Idempotent + `--dry-run`,
 * mirroring `init`.
 *
 * For standalone `harn` on a terminal it also handles the destructive extra
 * conversationally: when `--purge-state` wasn't passed and `.harnery/` exists, it
 * asks before deleting it, and afterward it prints how to remove the harnery CLI
 * itself (which a running process can't do to its own package). Both are gated to
 * standalone harn — an embedding host routes output through its own emit and owns
 * its install lifecycle — and the prompt never fires off a TTY, so scripted / CI
 * runs keep the flag-driven behavior untouched. The shell wrapper `uninstall.sh`
 * is the fuller mirror (it also unlinks the PATH bins and can delete the clone).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { DEFAULT_BIN_NAME } from "../core/config.ts";
import { HARNESS_SPECS, type HarnessId } from "../core/hooks/harness/events.ts";
import { type SettingsFile, unwireHooks } from "./init.ts";

interface UninstallOpts {
  harness: string;
  dryRun?: boolean;
  projectRoot?: string;
  purgeState?: boolean;
}

export function registerUninstallCommand(
  program: Command,
  emit: EmitContext,
  binName?: string,
): void {
  // The interactive prompt + engine-removal hint are standalone-harn niceties.
  // An embedding host routes output through its own emit and owns its install
  // lifecycle, so for a host (binName set + non-default) uninstall stays strictly
  // flag-driven and says nothing about removing "the package".
  const standalone = !binName || binName === DEFAULT_BIN_NAME;

  program
    .command("uninstall")
    .description(
      "Reverse `harn init`: remove harnery's hook entries from the harness " +
        "settings file (keeps any others). Pass --purge-state to also delete the " +
        ".harnery/ coord root (on a terminal it asks first). Idempotent; use " +
        "--dry-run to preview.",
    )
    .option("--harness <id>", "claude-code | cursor | codex", "claude-code")
    .option("--dry-run", "Show what would change without writing")
    .option("--project-root <path>", "Project root (default: git toplevel, else cwd)")
    .option("--purge-state", "Also delete the .harnery/ coord root (runtime state, destructive)")
    .action(async (opts: UninstallOpts) => {
      const harness = opts.harness as HarnessId;
      const spec = HARNESS_SPECS[harness];
      if (!spec) {
        emit.text(`Unknown harness '${opts.harness}'. Expected: claude-code | cursor | codex.`);
        emit.setExitCode(1);
        return;
      }

      const projectRoot = resolve(opts.projectRoot ?? gitTopLevel() ?? process.cwd());
      const dryRun = opts.dryRun === true;
      const coordDir = resolve(projectRoot, ".harnery");
      const coordExists = existsSync(coordDir);
      let purgeState = opts.purgeState === true;
      const actions: string[] = [];

      // ── 0. interactive: offer to delete .harnery/ (standalone harn, TTY) ───
      if (
        shouldPromptForState({
          standalone,
          interactive: process.stdin.isTTY === true,
          dryRun,
          purgeState,
          coordExists,
        })
      ) {
        purgeState = await confirmDeleteState(coordDir);
      }

      // ── 1. unwire harness hooks ────────────────────────────────────────────
      const settingsPath = resolve(projectRoot, spec.settingsFile);
      if (!existsSync(settingsPath)) {
        actions.push(`· ${rel(projectRoot, settingsPath)} doesn't exist; no hooks to remove`);
      } else {
        let settings: SettingsFile;
        try {
          settings = JSON.parse(readFileSync(settingsPath, "utf8")) as SettingsFile;
        } catch (err) {
          emit.text(
            `✗ ${rel(projectRoot, settingsPath)} exists but isn't valid JSON; refusing to ` +
              `touch it. Fix it and re-run.\n  (${(err as Error).message})`,
          );
          emit.setExitCode(1);
          return;
        }
        const { removed, remaining } = unwireHooks(settings);
        if (removed === 0) {
          actions.push(`· no harnery hooks found in ${rel(projectRoot, settingsPath)}`);
        } else if (harnessOnly(settings)) {
          // Nothing left but what init itself put there (no hooks, at most a
          // version key), so remove the file rather than leave an empty shell.
          if (dryRun) {
            actions.push(`+ would remove ${rel(projectRoot, settingsPath)} (now harnery-only)`);
          } else {
            rmSync(settingsPath);
            actions.push(`+ removed ${rel(projectRoot, settingsPath)} (was harnery-only)`);
          }
        } else if (dryRun) {
          actions.push(
            `+ would remove ${removed} harnery hook(s) from ${rel(projectRoot, settingsPath)} ` +
              `(${remaining} other hook(s) kept)`,
          );
        } else {
          writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
          actions.push(
            `+ removed ${removed} harnery hook(s) from ${rel(projectRoot, settingsPath)} ` +
              `(${remaining} other hook(s) kept)`,
          );
        }
      }

      // ── 2. coord root (opt-in; destructive) ────────────────────────────────
      if (purgeState) {
        if (!coordExists) {
          actions.push("· .harnery/ doesn't exist; nothing to purge");
        } else if (dryRun) {
          actions.push("+ would delete .harnery/ and all coord state (events, councils, scratch)");
        } else {
          rmSync(coordDir, { recursive: true, force: true });
          actions.push("+ deleted .harnery/ and all coord state");
        }
      } else if (coordExists) {
        actions.push("· left .harnery/ coord root in place (pass --purge-state to delete it)");
      }

      const hint = standalone && !dryRun ? engineRemovalHint() : null;
      emit.text(render(projectRoot, dryRun, actions, hint));
    });
}

/**
 * Whether to interactively ask before deleting `.harnery/`. True only for
 * standalone harn on a TTY, when the user didn't already answer with
 * --purge-state, it isn't a dry run, and there's actually a coord root to
 * delete. Pure so the gating is unit-testable without a terminal.
 */
export function shouldPromptForState(o: {
  standalone: boolean;
  interactive: boolean;
  dryRun: boolean;
  purgeState: boolean;
  coordExists: boolean;
}): boolean {
  return o.standalone && o.interactive && !o.dryRun && !o.purgeState && o.coordExists;
}

/**
 * The "harnery itself is still installed" line shown to standalone-harn users
 * after a real uninstall. `harn uninstall` can't remove the package it's running
 * from, so it points at the two ways to finish the job. Pure + exported for the
 * test.
 */
export function engineRemovalHint(): string {
  return (
    "harnery itself is still installed. To remove the CLI too: `npm rm -g harnery` " +
    "(if you installed it with npm/bun), or delete the clone (`uninstall.sh --remove-clone` " +
    "does that for a git clone)."
  );
}

/** Mirror uninstall.sh's wording: explain what .harnery/ holds, then ask. */
function confirmDeleteState(coordDir: string): Promise<boolean> {
  process.stdout.write(
    "\nharnery saved this project's coordination history in .harnery/\n" +
      "(its event log, councils, agent identities, and scratchpads):\n" +
      `    ${coordDir}\n` +
      "Unwiring leaves that in place. Deleting it can't be undone.\n",
  );
  return confirm("Delete this project's harnery history too? [y/N]");
}

/** Read one y/N answer from the TTY. Yes only on an explicit y / yes. */
function confirm(question: string): Promise<boolean> {
  return new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} `, (answer) => {
      rl.close();
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** True when an unwired settings object holds nothing but (optionally) `version`. */
function harnessOnly(settings: SettingsFile): boolean {
  const keys = Object.keys(settings);
  return keys.length === 0 || (keys.length === 1 && keys[0] === "version");
}

function render(
  projectRoot: string,
  dryRun: boolean,
  actions: string[],
  hint: string | null,
): string {
  const head = dryRun ? "harn uninstall (dry run): no changes written" : "harn uninstall";
  const tail = dryRun
    ? "\nRe-run without --dry-run to apply."
    : "\nDone. harnery hooks are unwired; restart your harness session to drop them.";
  const hintBlock = hint ? `\n\n${hint}` : "";
  return `${head}\n  root: ${projectRoot}\n${actions.map((a) => `  ${a}`).join("\n")}${tail}${hintBlock}`;
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
