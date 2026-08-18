/**
 * `harn doctor`: runtime + dependency check.
 *
 * Walks through every dependency harnery touches and reports presence,
 * version, and OS-specific install hints. Returns a checklist:
 *
 *   ✓ ok: dep is present and recent enough
 *   ⚠ warn: optional dep missing (feature degrades)
 *   ✗ fail: required dep missing (commands will throw)
 *
 * Exits 0 unless a required dep is missing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { BUILTIN_ADAPTER_IDS } from "../core/adapters/index.ts";
import { resolveBinName, ripgrepAutoInstall } from "../core/config.ts";
import { ADAPTER_SPECS, type AdapterId } from "../core/hooks/adapter/events.ts";
import { loadAdapterWiring, summarizeAdapterWiring } from "../core/hooks/adapter/wiring.ts";
import {
  type CodexHookAuthorizationResult,
  probeCodexHookAuthorization,
} from "../core/hooks/codex-authorization.ts";
import {
  type CodexWslBridgeStatus,
  inspectCodexWslBridge,
} from "../core/hooks/codex-wsl-bridge.ts";
import {
  ADAPTER_BINARIES,
  ADAPTER_INSTALL_HINTS,
  ADAPTER_LOGIN_HINTS,
} from "../core/workflow/adapters.ts";
import { probeBilling } from "../core/workflow/billing.ts";
import type { AdapterName } from "../core/workflow/types.ts";
import { checkGitHooks, gitHooksInstalled } from "../lib/instructions/git-hooks.ts";
import { findRg, installRg, managedRgPath, rgInstallSupported } from "../lib/tools/ripgrep.ts";

type Severity = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  severity: Severity;
  detail: string;
  hint?: string;
}

interface CheckOpts {
  json?: boolean;
  fix?: boolean;
}

export function registerDoctorCommand(program: Command, emit: EmitContext): void {
  program
    .command("doctor")
    .description(
      "Verify the runtime + optional deps harnery commands expect. Exits 0 " +
        "unless a required dep (Node, git) is missing.",
    )
    .option("--json", "Machine-readable JSON output")
    .option(
      "--fix",
      "Install missing managed tools (currently: ripgrep, pinned + checksum-verified)",
    )
    .action(async (opts: CheckOpts) => {
      if (opts.fix && !findRg() && rgInstallSupported()) {
        try {
          await installRg((line) => emit.text(`${line}\n`));
        } catch (err) {
          emit.text(`ripgrep install failed: ${(err as Error).message}\n`);
        }
      }
      const checks = await runChecks();
      const requiredFailed = checks.some((c) => c.severity === "fail");

      if (opts.json) {
        emit.data({
          checks,
          summary: {
            total: checks.length,
            ok: checks.filter((c) => c.severity === "ok").length,
            warn: checks.filter((c) => c.severity === "warn").length,
            fail: checks.filter((c) => c.severity === "fail").length,
          },
        });
        emit.setExitCode(requiredFailed ? 1 : 0);
        return;
      }

      const symbols: Record<Severity, string> = { ok: "✓", warn: "⚠", fail: "✗" };
      const widest = Math.max(...checks.map((c) => c.name.length));
      const lines: string[] = [];
      for (const c of checks) {
        lines.push(`${symbols[c.severity]} ${c.name.padEnd(widest)}  ${c.detail}`);
        if (c.hint) lines.push(`    ↳ ${c.hint}`);
      }

      const summary = `\n${checks.filter((c) => c.severity === "ok").length} ok, ${
        checks.filter((c) => c.severity === "warn").length
      } warn, ${checks.filter((c) => c.severity === "fail").length} fail`;
      emit.text(`${lines.join("\n")}${summary}`);
      emit.setExitCode(requiredFailed ? 1 : 0);
    });
}

export async function runChecks(): Promise<Check[]> {
  const codexWslStatus = inspectCodexWslBridge();
  const codexWslBridge = checkCodexWslBridge(codexWslStatus);
  // Probe the adapter CLIs before the hook check runs, not in output order:
  // an unwired adapter only matters if its CLI is actually installed, and
  // probing once here keeps that join to one spawn per CLI.
  const workflow = BUILTIN_ADAPTER_IDS.map((id) => ({ id, ...checkWorkflowAdapter(id) }));
  const installed = workflow.filter((w) => w.installed).map((w) => w.id as AdapterId);
  const codexAuthorization = await checkCodexHookAuthorization(installed, codexWslStatus);
  return [
    checkNode(),
    checkGit(),
    checkBun(),
    checkRipgrep(),
    checkHarneryDir(),
    checkAdapterHooks(installed),
    ...(codexAuthorization ? [codexAuthorization] : []),
    checkGitHookRegions(),
    ...(codexWslBridge ? [codexWslBridge] : []),
    ...workflow.map((w) => w.check),
    checkRestic(),
    checkRclone(),
    checkPlaywright(),
    checkPython(),
  ];
}

function checkGitHookRegions(): Check {
  const root = findCoordProjectRoot();
  if (!root) {
    return { name: "git hooks", severity: "ok", detail: "n/a (no .harnery/ above cwd)" };
  }
  try {
    if (!gitHooksInstalled(root)) {
      const bin = resolveBinName(root);
      return {
        name: "git hooks",
        severity: "warn",
        detail:
          `not installed - commits are not guarded against peer-claim conflicts and ` +
          `claims never auto-release on commit/checkout; run \`${bin} init\` to install`,
      };
    }
    const { status, issues } = checkGitHooks(root);
    if (status === "fresh") {
      return { name: "git hooks", severity: "ok", detail: "managed regions current" };
    }
    return { name: "git hooks", severity: "warn", detail: issues.join("; ") };
  } catch (err) {
    return {
      name: "git hooks",
      severity: "warn",
      detail: `check failed: ${(err as Error).message}`,
    };
  }
}

function checkCodexWslBridge(status: CodexWslBridgeStatus | null): Check | null {
  if (!status) return null;
  return {
    name: "codex:WSL bridge",
    severity: status.ok ? "ok" : "warn",
    detail: status.detail,
    hint: status.ok
      ? undefined
      : "forward CODEX_THREAD_ID through WSLENV in the Codex shell environment policy, then start a fresh task",
  };
}

export function codexAuthorizationCheck(result: CodexHookAuthorizationResult): Check {
  const reviewHint =
    "terminal UI: run `/hooks`; Codex Desktop: open Settings > Hooks; after approval, start a fresh task";
  if (result.status === "runnable") {
    return { name: "codex:hook authorization", severity: "ok", detail: result.detail };
  }
  if (result.status === "review_required" || result.status === "disabled") {
    return {
      name: "codex:hook authorization",
      severity: "warn",
      detail: result.detail,
      hint: reviewHint,
    };
  }
  return {
    name: "codex:hook authorization",
    severity: "warn",
    detail: `authorization unverified: ${result.detail}`,
    hint: reviewHint,
  };
}

async function checkCodexHookAuthorization(
  installedAdapters: AdapterId[],
  codexWslStatus: CodexWslBridgeStatus | null,
): Promise<Check | null> {
  const root = findCoordProjectRoot();
  if (!root || !summarizeAdapterWiring(root).wired.includes("codex")) return null;

  if (codexWslStatus) {
    return {
      name: "codex:hook authorization",
      severity: "warn",
      detail:
        "unverified from WSL; the Windows-native Codex runtime owns this workspace's trust state",
      hint: "run the host's Windows bridge doctor, or open Codex Desktop Settings > Hooks; start a fresh task after approval",
    };
  }
  if (!installedAdapters.includes("codex")) return null;

  return codexAuthorizationCheck(await probeCodexHookAuthorization({ cwd: root }));
}

function checkRipgrep(): Check {
  const found = findRg();
  if (found) {
    const r = whichVersion(found);
    const managed = found === managedRgPath() ? ", managed" : "";
    return {
      name: "ripgrep",
      severity: "ok",
      detail: `${r.out.replace(/^ripgrep\s*/, "")} (${found === "rg" ? "PATH" : found}${managed})`,
    };
  }
  if (!rgInstallSupported()) {
    return {
      name: "ripgrep",
      severity: "warn",
      detail: "missing (grep fallback; no pinned artifact for this OS/arch)",
      hint: "https://github.com/BurntSushi/ripgrep#installation",
    };
  }
  if (ripgrepAutoInstall()) {
    return {
      name: "ripgrep",
      severity: "warn",
      detail: "missing (autoInstall on: will self-provision on first grep)",
    };
  }
  return {
    name: "ripgrep",
    severity: "warn",
    detail: "missing (grep fallback works, just slower)",
    hint: `${resolveBinName()} doctor --fix  (pinned + checksum-verified, installs to the harnery tools dir)`,
  };
}

function whichVersion(bin: string, args: string[] = ["--version"]): { ok: boolean; out: string } {
  const r = spawnSync(bin, args, { encoding: "utf-8" });
  if (r.status !== 0) return { ok: false, out: "" };
  const out = (r.stdout || r.stderr).trim().split("\n")[0];
  return { ok: true, out };
}

/**
 * One workflow spawn target: is the adapter CLI installed, and how will its
 * headless children bill (subscription login vs API key — see billing.ts)?
 * Missing is a warn, not a fail: workflows degrade to the adapters you have.
 *
 * Reports `installed` alongside the check so `checkAdapterHooks` can reuse the
 * probe instead of spawning every adapter CLI a second time.
 */
function checkWorkflowAdapter(adapter: AdapterName): { check: Check; installed: boolean } {
  const bin = ADAPTER_BINARIES[adapter];
  const name = `workflow:${adapter}`;
  const r = whichVersion(bin);
  if (!r.ok) {
    return {
      check: {
        name,
        severity: "warn",
        detail: `${bin} missing (workflow --adapter ${adapter} unavailable)`,
        hint: `${ADAPTER_INSTALL_HINTS[adapter]}  then: ${ADAPTER_LOGIN_HINTS[adapter]}`,
      },
      installed: false,
    };
  }
  const probe = probeBilling(adapter);
  if (probe.login === "absent" && !probe.apiKeyPresent) {
    return {
      check: {
        name,
        severity: "warn",
        detail: `${r.out} — installed, but no stored login or API key detected`,
        hint: ADAPTER_LOGIN_HINTS[adapter],
      },
      installed: true,
    };
  }
  const billing =
    probe.mode === "subscription"
      ? probe.login === "present"
        ? "billing: subscription"
        : "billing: subscription (login unverifiable, CLI is the authority)"
      : `billing: ${probe.mode} (${probe.apiKeySource})`;
  return { check: { name, severity: "ok", detail: `${r.out} — ${billing}` }, installed: true };
}

function checkNode(): Check {
  const v = process.versions.node;
  const major = Number.parseInt(v.split(".")[0], 10);
  if (Number.isNaN(major) || major < 20) {
    return {
      name: "node",
      severity: "fail",
      detail: `${v} (need ≥ 20)`,
      hint: "https://nodejs.org/en/download",
    };
  }
  return { name: "node", severity: "ok", detail: v };
}

function checkGit(): Check {
  const r = whichVersion("git");
  if (!r.ok) {
    return {
      name: "git",
      severity: "fail",
      detail: "missing",
      hint: macOrLinux("brew install git", "apt-get install -y git"),
    };
  }
  return { name: "git", severity: "ok", detail: r.out.replace(/^git version\s*/, "") };
}

function checkBun(): Check {
  const r = whichVersion("bun");
  if (!r.ok) {
    return {
      name: "bun",
      severity: "warn",
      detail: "missing (Node-only mode: fine, just slower than bun-native)",
      hint: "curl -fsSL https://bun.sh/install | bash",
    };
  }
  return { name: "bun", severity: "ok", detail: r.out };
}

function checkRestic(): Check {
  const r = whichVersion("restic", ["version"]);
  if (!r.ok) {
    return {
      name: "restic",
      severity: "warn",
      detail: "missing (needed for `harn backup`)",
      hint: macOrLinux("brew install restic", "apt-get install -y restic"),
    };
  }
  return { name: "restic", severity: "ok", detail: r.out };
}

function checkRclone(): Check {
  const r = whichVersion("rclone", ["version"]);
  if (!r.ok) {
    return {
      name: "rclone",
      severity: "warn",
      detail: "missing (needed for `harn sync`)",
      hint: "curl https://rclone.org/install.sh | sudo bash",
    };
  }
  // first line is "rclone v1.XX.X"
  return { name: "rclone", severity: "ok", detail: r.out };
}

function checkPlaywright(): Check {
  // Check if playwright is importable + chromium installed.
  try {
    const moduleId = "playwright";
    require.resolve(moduleId);
  } catch {
    return {
      name: "playwright",
      severity: "warn",
      detail: "module missing (needed for `harn browse`)",
      hint: "npm install -g playwright && npx playwright install chromium",
    };
  }
  // Check chromium browser binary exists.
  const home = os.homedir();
  const candidates = [
    path.join(home, ".cache", "ms-playwright"),
    path.join(home, "Library", "Caches", "ms-playwright"),
  ];
  const found = candidates.find(existsSync);
  if (!found) {
    return {
      name: "playwright",
      severity: "warn",
      detail: "module ok but no browsers installed",
      hint: "npx playwright install chromium",
    };
  }
  return { name: "playwright", severity: "ok", detail: `module + browsers at ${found}` };
}

function checkPython(): Check {
  const r = whichVersion("python3");
  if (!r.ok) {
    return {
      name: "python3",
      severity: "warn",
      detail: "missing (optional; some examples use python)",
    };
  }
  return { name: "python3", severity: "ok", detail: r.out };
}

/** Walk up from cwd to the nearest dir containing `.harnery/`; null if none. */
function findCoordProjectRoot(): string | null {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, ".harnery"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function checkHarneryDir(): Check {
  const root = findCoordProjectRoot();
  if (root) {
    return { name: ".harnery/", severity: "ok", detail: path.join(root, ".harnery") };
  }
  return {
    name: ".harnery/",
    severity: "warn",
    detail: "no .harnery/ found above cwd",
    hint: "initialize the project with `harn init` from the repository root",
  };
}

/**
 * Compare the project's wired adapter hooks against ADAPTER_SPECS. Catches the
 * post-upgrade case where a harnery release added (or renamed) a hook event but
 * the consumer's settings file hasn't been re-wired. Only fires for a adapter
 * the project has opted into (≥1 harnery hook already wired) — see
 * loadAdapterWiring — so a bare settings file never false-warns. The remedy is
 * always the same: re-run `<bin> init` (idempotent, additive).
 */
function checkAdapterHooks(installedAdapters: AdapterId[] = []): Check {
  const root = findCoordProjectRoot();
  if (!root) {
    return { name: "adapter hooks", severity: "ok", detail: "n/a (no .harnery/ above cwd)" };
  }
  const drift = loadAdapterWiring(root);
  // A adapter with zero harnery hooks is only worth flagging when the project
  // plainly uses harnery hooks (something else is wired) AND that adapter's CLI
  // is installed. Both conditions matter: the first keeps a project that has
  // never run init quiet, the second keeps a project that simply doesn't have
  // Codex quiet. What's left is the case that reads as healthy but isn't — an
  // agent can start a session through that adapter and register nothing.
  const summary = summarizeAdapterWiring(root);
  const unwired =
    summary.wired.length > 0 ? summary.unwired.filter((id) => installedAdapters.includes(id)) : [];
  if (drift.length === 0 && unwired.length === 0) {
    return { name: "adapter hooks", severity: "ok", detail: "wired + current" };
  }
  const bin = resolveBinName(root);
  const parts = drift.map((d) => {
    const bits: string[] = [];
    if (d.parseError) bits.push(`invalid JSON (${d.parseError})`);
    if (d.missing.length > 0) {
      bits.push(`${d.missing.length} missing (${d.missing.map((m) => m.subcommand).join(", ")})`);
    }
    if (d.orphans.length > 0) bits.push(`${d.orphans.length} orphaned (${d.orphans.join(", ")})`);
    if (d.invalidTopLevelKeys.length > 0) {
      bits.push(`invalid fields (${d.invalidTopLevelKeys.join(", ")})`);
    }
    if (d.invalidEventKeys.length > 0) {
      bits.push(`unsupported events (${d.invalidEventKeys.join(", ")})`);
    }
    return `${d.settingsFile}: ${bits.join("; ")}`;
  });
  for (const id of unwired) {
    parts.push(`${ADAPTER_SPECS[id].settingsFile}: ${id} CLI installed, no harnery hooks wired`);
  }
  const needsManualRepair = drift.some(
    (d) => d.parseError || d.invalidTopLevelKeys.length > 0 || d.invalidEventKeys.length > 0,
  );
  const wireHints = unwired.map((id) => `\`${bin} init --adapter ${id}\``);
  let hint: string;
  if (needsManualRepair) {
    hint = `repair the invalid adapter settings, then run \`${bin} init\` to migrate harnery hooks`;
  } else if (drift.length > 0) {
    hint = `run \`${bin} init\` to migrate the hook set (idempotent)`;
    if (wireHints.length > 0) hint += `; ${wireHints.join(" and ")} to wire the rest`;
  } else {
    hint = `run ${wireHints.join(" and ")} (idempotent, additive)`;
  }
  return { name: "adapter hooks", severity: "warn", detail: parts.join("  |  "), hint };
}

function macOrLinux(mac: string, linux: string): string {
  return os.platform() === "darwin" ? mac : linux;
}
