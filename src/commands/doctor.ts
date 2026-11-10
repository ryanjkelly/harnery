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
 * Every check also has a scope. A `runtime` check describes something
 * Harnery itself runs on or uses; a failing one always exits 1. An
 * `environment` check describes the surrounding machine, such as the
 * `node` on PATH while Harnery runs on Bun. A failing environment check
 * exits 1 too, unless the project sets `doctor.environmentFindings` to
 * `"report"` (see `doctorOutcome`).
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { BUILTIN_ADAPTER_IDS } from "../core/adapters/index.ts";
import {
  codexWindowsBridgeConfig,
  type DoctorEnvironmentFindings,
  doctorEnvironmentFindings,
  inspectTimeZone,
  resolveBinName,
  ripgrepAutoInstall,
  type TimeZoneResolution,
  timeZoneSourceLabel,
} from "../core/config.ts";
import {
  countSummarizedSinceV3,
  listDiagnosticSummariesV3,
} from "../core/events/v3/producers/diagnostic-summaries.ts";
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
import { findUnfinishedHookRuns } from "../core/hooks/run-markers.ts";
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

/**
 * `runtime`: Harnery cannot run safely or correctly while this fails.
 * `environment`: a finding about the machine that Harnery itself does not
 * depend on. When unsure, a check is `runtime`, the strict side.
 */
export type CheckScope = "runtime" | "environment";

export interface Check {
  name: string;
  scope: CheckScope;
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
      "Verify the runtime + optional deps harnery commands expect. Exits 1 " +
        "when a check fails; a project can report failing environment checks " +
        "without failing (doctor.environmentFindings).",
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
      const report = doctorReport(checks, doctorEnvironmentFindings(findCoordProjectRoot()));
      if (opts.json) emit.data(report.json);
      else emit.text(report.text);
      emit.setExitCode(report.exitCode);
    });
}

/** The `--json` payload, the text report and the exit code for one run. */
export function doctorReport(
  checks: Check[],
  setting: { mode: DoctorEnvironmentFindings; error: string | null },
): { json: Record<string, unknown>; text: string; exitCode: 0 | 1 } {
  const outcome = doctorOutcome(checks, setting.mode);
  const all = setting.error ? [...checks, doctorSettingCheck(setting.error)] : checks;
  const count = (severity: Severity) => all.filter((c) => c.severity === severity).length;
  const json = {
    checks: all,
    summary: {
      total: all.length,
      ok: count("ok"),
      warn: count("warn"),
      fail: count("fail"),
      runtimeFail: outcome.runtimeFail,
      environmentFail: outcome.environmentFail,
    },
    environmentFindings: setting.mode,
    outcome: outcome.outcome,
  };

  const symbols: Record<Severity, string> = { ok: "✓", warn: "⚠", fail: "✗" };
  const widest = Math.max(...all.map((c) => c.name.length));
  const lines: string[] = [];
  for (const c of all) {
    lines.push(`${symbols[c.severity]} ${c.name.padEnd(widest)}  ${c.detail}`);
    if (c.hint) lines.push(`    ↳ ${c.hint}`);
    if (c.scope === "environment" && c.severity === "fail") {
      lines.push(
        setting.mode === "report"
          ? '    ↳ environment finding: Harnery does not run on this; reported without failing (doctor.environmentFindings is "report")'
          : "    ↳ environment finding: Harnery does not run on this, but it still fails doctor",
      );
    }
  }
  let summary = `\n${count("ok")} ok, ${count("warn")} warn, ${count("fail")} fail`;
  if (outcome.outcome === "reported") {
    summary += ` (${outcome.environmentFail} environment finding${
      outcome.environmentFail === 1 ? "" : "s"
    } reported without failing)`;
  }
  return { json, text: `${lines.join("\n")}${summary}`, exitCode: outcome.exitCode };
}

export interface DoctorOutcome {
  /** `pass`: nothing failed. `reported`: only environment checks failed and the project reports them. `fail`: exit 1. */
  outcome: "pass" | "reported" | "fail";
  exitCode: 0 | 1;
  runtimeFail: number;
  environmentFail: number;
}

/**
 * Decide the exit code. A failing runtime check always fails; no setting
 * changes that. Failing environment checks fail too unless the project
 * opted in with `doctor.environmentFindings: "report"`, in which case they
 * stay in the report and the outcome is `reported`.
 */
export function doctorOutcome(checks: Check[], mode: DoctorEnvironmentFindings): DoctorOutcome {
  const failing = checks.filter((c) => c.severity === "fail");
  const runtimeFail = failing.filter((c) => c.scope !== "environment").length;
  const environmentFail = failing.length - runtimeFail;
  if (runtimeFail > 0 || (environmentFail > 0 && mode === "fail")) {
    return { outcome: "fail", exitCode: 1, runtimeFail, environmentFail };
  }
  return {
    outcome: environmentFail > 0 ? "reported" : "pass",
    exitCode: 0,
    runtimeFail,
    environmentFail,
  };
}

/** Shown only when `doctor.environmentFindings` holds a value doctor ignored. */
function doctorSettingCheck(error: string): Check {
  return {
    name: "doctor settings",
    scope: "runtime",
    severity: "warn",
    detail: `${error}; environment findings fail doctor`,
    hint: 'set doctor.environmentFindings to "fail" or "report" in .harnery/config.jsonc',
  };
}

export async function runChecks(): Promise<Check[]> {
  const root = findCoordProjectRoot();
  const codexWslStatus = inspectCodexWslBridge();
  const recentCodexMidFlightCount = root ? countRecentCodexMidFlightOnboardings(root) : 0;
  const codexWslBridge = codexWslBridgeCheck(codexWslStatus, recentCodexMidFlightCount);
  const codexHookRuns = codexHookRunsCheck(root);
  const codexWindowsRoute = codexWindowsBridgeCheck(root);
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
    timeZoneCheck(inspectTimeZone(root)),
    checkAdapterHooks(installed),
    ...(codexAuthorization ? [codexAuthorization] : []),
    checkGitHookRegions(),
    ...(codexWslBridge ? [codexWslBridge] : []),
    ...(codexWindowsRoute ? [codexWindowsRoute] : []),
    ...(codexHookRuns ? [codexHookRuns] : []),
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
    return {
      name: "git hooks",
      scope: "runtime",
      severity: "ok",
      detail: "n/a (no .harnery/ above cwd)",
    };
  }
  try {
    if (!gitHooksInstalled(root)) {
      const bin = resolveBinName(root);
      return {
        name: "git hooks",
        scope: "runtime",
        severity: "warn",
        detail:
          `not installed - commits are not guarded against peer-claim conflicts and ` +
          `claims never auto-release on commit/checkout; run \`${bin} init\` to install`,
      };
    }
    const { status, issues } = checkGitHooks(root);
    if (status === "fresh") {
      return {
        name: "git hooks",
        scope: "runtime",
        severity: "ok",
        detail: "managed regions current",
      };
    }
    return { name: "git hooks", scope: "runtime", severity: "warn", detail: issues.join("; ") };
  } catch (err) {
    return {
      name: "git hooks",
      scope: "runtime",
      severity: "warn",
      detail: `check failed: ${(err as Error).message}`,
    };
  }
}

export function codexWslBridgeCheck(
  status: CodexWslBridgeStatus | null,
  recentMidFlightCount = 0,
): Check | null {
  if (!status && recentMidFlightCount === 0) return null;
  const historical =
    recentMidFlightCount === 0
      ? null
      : `${recentMidFlightCount} Codex mid-flight onboarding${recentMidFlightCount === 1 ? "" : "s"} recorded in the last 48h`;
  return {
    name: "codex:WSL bridge",
    scope: "runtime",
    severity: status?.ok && !historical ? "ok" : "warn",
    detail: [status?.detail, historical].filter(Boolean).join("; "),
    hint:
      status?.ok && !historical
        ? undefined
        : "forward CODEX_THREAD_ID through WSLENV in the Codex shell environment policy, then start a fresh task",
  };
}

/**
 * Hook runs that started but never finished (ADR 0197). Codex kills a hook at
 * its timeout and the tool proceeds without that hook's checks; the start
 * marker is the only trace such a run leaves.
 */
export function codexHookRunsCheck(
  coordRoot: string | null,
  nowMs = Date.now(),
  isAlive?: (pid: number) => boolean,
): Check | null {
  if (!coordRoot) return null;
  const runs = findUnfinishedHookRuns(coordRoot, nowMs, undefined, isAlive);
  if (runs.count === 0) return null;
  const events = runs.events.map((e) => `${e.event} ×${e.count}`).join(", ");
  return {
    name: "codex:hook runs",
    scope: "runtime",
    severity: "warn",
    detail:
      `${runs.count} hook run${runs.count === 1 ? "" : "s"} started but never finished in the last 24h ` +
      `(${events}; latest ${runs.latest}); their tools proceeded without those hooks' checks`,
    hint: "a hook that outlives its timeout is killed; look for a stalled WSL session or a slow hook",
  };
}

/**
 * Report the zone used for human-facing times and journal stamps. An explicit
 * setting that names no known zone fails here; at runtime it only warns and
 * falls through, so hooks never break over it.
 */
export function timeZoneCheck(resolution: TimeZoneResolution): Check {
  const using = `${resolution.zone} (${timeZoneSourceLabel(resolution.source)})`;
  if (resolution.invalid.length > 0) {
    const bad = resolution.invalid
      .map((b) => `${JSON.stringify(b.value)} from ${timeZoneSourceLabel(b.source)}`)
      .join("; ");
    return {
      name: "time zone",
      scope: "runtime",
      severity: "fail",
      detail: `invalid setting ${bad}; using ${using}`,
      hint: 'set an IANA zone name such as "Europe/Berlin" or "UTC", or remove the setting to use the system zone',
    };
  }
  return { name: "time zone", scope: "runtime", severity: "ok", detail: using };
}

/** Report the per-project Windows bridge opt-in, or an invalid value init ignored. */
export function codexWindowsBridgeCheck(coordRoot: string | null): Check | null {
  if (!coordRoot) return null;
  const bridge = codexWindowsBridgeConfig(coordRoot);
  if (bridge.error) {
    return {
      name: "codex:Windows hook route",
      scope: "runtime",
      severity: "warn",
      detail: `${bridge.error}; Codex hooks are wired without commandWindows`,
      hint: "set hooks.codexWindowsBridge.entryPoint to a plain command name in .harnery/config.jsonc, then re-run init",
    };
  }
  if (!bridge.entryPoint) return null;
  return {
    name: "codex:Windows hook route",
    scope: "runtime",
    severity: "ok",
    detail:
      `opted in: Windows-native Codex hooks hand off to \`${bridge.entryPoint}\` from WSL paths ` +
      `when it is on PATH, otherwise run the usual command; bridge health is reported by the bridge itself`,
  };
}

const CODEX_MID_FLIGHT_HISTORY_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Count bounded, privacy-safe recovery diagnostics so a healthy environment
 * now does not hide an intermittent Codex-to-WSL identity drop. */
export function countRecentCodexMidFlightOnboardings(
  coordRoot: string,
  nowMs = Date.now(),
  windowMs = CODEX_MID_FLIGHT_HISTORY_WINDOW_MS,
): number {
  // Occurrences past the producer's loose-exemplar bound live in summary
  // files instead of loose diagnostics; count them too so the mitigation
  // cannot hide an active Codex identity drop from this warning.
  let count = 0;
  try {
    const listing = listDiagnosticSummariesV3(coordRoot);
    count += countSummarizedSinceV3(
      listing.summaries,
      nowMs - windowMs,
      (summary) =>
        summary.category === "mid_flight_onboarding" && summary.metadata.adapter === "codex",
      nowMs,
    );
  } catch {
    // Summary reads are best-effort; loose diagnostics below still count.
  }
  const directory = path.join(coordRoot, ".harnery", "ledgers", "v3", "diagnostics");
  if (!existsSync(directory)) return count;
  for (const name of readdirSync(directory)) {
    if (!name.startsWith("mid_flight_onboarding-") || !name.endsWith(".json")) continue;
    try {
      const row = JSON.parse(readFileSync(path.join(directory, name), "utf8")) as {
        recorded_at?: unknown;
        category?: unknown;
        adapter?: unknown;
      };
      const recordedAt = typeof row.recorded_at === "string" ? Date.parse(row.recorded_at) : NaN;
      if (
        row.category === "mid_flight_onboarding" &&
        row.adapter === "codex" &&
        Number.isFinite(recordedAt) &&
        recordedAt <= nowMs &&
        nowMs - recordedAt <= windowMs
      ) {
        count += 1;
      }
    } catch {
      // A malformed best-effort diagnostic cannot make doctor fail.
    }
  }
  return count;
}

export function codexAuthorizationCheck(result: CodexHookAuthorizationResult): Check {
  const reviewHint =
    "terminal UI: run `/hooks`; Codex Desktop: open Settings > Hooks; after approval, start a fresh task";
  if (result.status === "runnable") {
    return {
      name: "codex:hook authorization",
      scope: "runtime",
      severity: "ok",
      detail: result.detail,
    };
  }
  if (result.status === "review_required" || result.status === "disabled") {
    return {
      name: "codex:hook authorization",
      scope: "runtime",
      severity: "warn",
      detail: result.detail,
      hint: reviewHint,
    };
  }
  return {
    name: "codex:hook authorization",
    scope: "runtime",
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
      scope: "runtime",
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
      scope: "runtime",
      severity: "ok",
      detail: `${r.out.replace(/^ripgrep\s*/, "")} (${found === "rg" ? "PATH" : found}${managed})`,
    };
  }
  if (!rgInstallSupported()) {
    return {
      name: "ripgrep",
      scope: "runtime",
      severity: "warn",
      detail: "missing (grep fallback; no pinned artifact for this OS/arch)",
      hint: "https://github.com/BurntSushi/ripgrep#installation",
    };
  }
  if (ripgrepAutoInstall()) {
    return {
      name: "ripgrep",
      scope: "runtime",
      severity: "warn",
      detail: "missing (autoInstall on: will self-provision on first grep)",
    };
  }
  return {
    name: "ripgrep",
    scope: "runtime",
    severity: "warn",
    detail: "missing (grep fallback works, just slower)",
    hint: `${resolveBinName()} doctor --fix  (pinned + checksum-verified, installs to the harnery tools dir)`,
  };
}

function whichVersion(bin: string, args: string[] = ["--version"]): { ok: boolean; out: string } {
  const r = spawnSync(bin, args, { windowsHide: true, encoding: "utf-8" });
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
        scope: "runtime",
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
        scope: "runtime",
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
  return {
    check: { name, scope: "runtime", severity: "ok", detail: `${r.out} — ${billing}` },
    installed: true,
  };
}

function checkNode(): Check {
  return nodeCheck(whichVersion("node"), process.versions);
}

/**
 * Report the `node` on PATH, which is what Node-based tools run. Under Bun,
 * `process.versions.node` is the Node version Bun emulates, not an installed
 * Node, so it is used only when doctor itself runs on Node and PATH has none.
 *
 * The scope follows the runtime: on Node.js this is the runtime Harnery runs
 * on; on Bun it is only the machine's `node`, an environment finding.
 */
export function nodeCheck(
  onPath: { ok: boolean; out: string },
  runtime: { node: string; bun?: string },
): Check {
  const hint = "https://nodejs.org/en/download";
  const scope: CheckScope = runtime.bun ? "environment" : "runtime";
  let v = onPath.ok ? onPath.out.replace(/^v/, "") : "";
  if (!v) {
    if (runtime.bun) {
      return {
        name: "node",
        scope,
        severity: "warn",
        detail: "not on PATH (Bun runs harnery; Node-based tools need it)",
        hint,
      };
    }
    v = runtime.node;
  }
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  const floors: Record<number, [number, number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
  const floor = floors[major];
  // These are the supported release lines containing the Brotli decoder fix.
  if (
    !match ||
    !(major > 26 || (floor && (minor > floor[0] || (minor === floor[0] && patch >= floor[1]))))
  ) {
    return {
      name: "node",
      scope,
      severity: "fail",
      detail: `${v} (need 22.23.4+, 24.22.1+, or 26.12.1+ on a supported line)`,
      hint,
    };
  }
  return { name: "node", scope, severity: "ok", detail: v };
}

function checkGit(): Check {
  const r = whichVersion("git");
  if (!r.ok) {
    return {
      name: "git",
      scope: "runtime",
      severity: "fail",
      detail: "missing",
      hint: macOrLinux("brew install git", "apt-get install -y git"),
    };
  }
  return {
    name: "git",
    scope: "runtime",
    severity: "ok",
    detail: r.out.replace(/^git version\s*/, ""),
  };
}

function checkBun(): Check {
  const r = whichVersion("bun");
  if (!r.ok) {
    return {
      name: "bun",
      scope: "runtime",
      severity: "warn",
      detail: "missing (Node-only mode: fine, just slower than bun-native)",
      hint: "curl -fsSL https://bun.sh/install | bash",
    };
  }
  return bunCheck(r.out);
}

export function bunCheck(version: string): Check {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  if (!match || !(major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 4))))) {
    return {
      name: "bun",
      scope: "runtime",
      severity: "fail",
      detail: `${version} (need ≥ 1.4.4 for the Brotli decoder fix)`,
      hint: "https://bun.sh/docs/installation",
    };
  }
  return { name: "bun", scope: "runtime", severity: "ok", detail: version };
}

function checkRestic(): Check {
  const r = whichVersion("restic", ["version"]);
  if (!r.ok) {
    return {
      name: "restic",
      scope: "runtime",
      severity: "warn",
      detail: "missing (needed for `harn backup`)",
      hint: macOrLinux("brew install restic", "apt-get install -y restic"),
    };
  }
  return { name: "restic", scope: "runtime", severity: "ok", detail: r.out };
}

function checkRclone(): Check {
  const r = whichVersion("rclone", ["version"]);
  if (!r.ok) {
    return {
      name: "rclone",
      scope: "runtime",
      severity: "warn",
      detail: "missing (needed for `harn sync`)",
      hint: "curl https://rclone.org/install.sh | sudo bash",
    };
  }
  // first line is "rclone v1.XX.X"
  return { name: "rclone", scope: "runtime", severity: "ok", detail: r.out };
}

function checkPlaywright(): Check {
  // Check if playwright is importable + chromium installed.
  try {
    const moduleId = "playwright";
    require.resolve(moduleId);
  } catch {
    return {
      name: "playwright",
      scope: "runtime",
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
      scope: "runtime",
      severity: "warn",
      detail: "module ok but no browsers installed",
      hint: "npx playwright install chromium",
    };
  }
  return {
    name: "playwright",
    scope: "runtime",
    severity: "ok",
    detail: `module + browsers at ${found}`,
  };
}

/** Environment: nothing in Harnery runs Python; only some examples do. */
function checkPython(): Check {
  const r = whichVersion("python3");
  if (!r.ok) {
    return {
      name: "python3",
      scope: "environment",
      severity: "warn",
      detail: "missing (optional; some examples use python)",
    };
  }
  return { name: "python3", scope: "environment", severity: "ok", detail: r.out };
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
    return {
      name: ".harnery/",
      scope: "runtime",
      severity: "ok",
      detail: path.join(root, ".harnery"),
    };
  }
  return {
    name: ".harnery/",
    scope: "runtime",
    severity: "warn",
    detail: "no .harnery/ found above cwd",
    hint: `initialize the project with \`${resolveBinName()} init\` from the repository root`,
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
    return {
      name: "adapter hooks",
      scope: "runtime",
      severity: "ok",
      detail: "n/a (no .harnery/ above cwd)",
    };
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
    return { name: "adapter hooks", scope: "runtime", severity: "ok", detail: "wired + current" };
  }
  const bin = resolveBinName(root);
  const parts = drift.map((d) => {
    const bits: string[] = [];
    if (d.parseError) bits.push(`invalid JSON (${d.parseError})`);
    if (d.missing.length > 0) {
      bits.push(`${d.missing.length} missing (${d.missing.map((m) => m.subcommand).join(", ")})`);
    }
    if (d.orphans.length > 0) bits.push(`${d.orphans.length} orphaned (${d.orphans.join(", ")})`);
    if (d.duplicates.length > 0) {
      bits.push(
        `${d.duplicates.length} duplicated (${d.duplicates.map((e) => e.settingsKey).join(", ")})`,
      );
    }
    if (d.misplaced.length > 0) {
      bits.push(
        `${d.misplaced.length} misplaced (${d.misplaced.map((e) => e.subcommand).join(", ")})`,
      );
    }
    if (d.stale.length > 0) {
      bits.push(`${d.stale.length} stale (${d.stale.map((e) => e.settingsKey).join(", ")})`);
    }
    if (d.invalidTopLevelKeys.length > 0) {
      bits.push(`invalid fields (${d.invalidTopLevelKeys.join(", ")})`);
    }
    if (d.invalidEventKeys.length > 0) {
      bits.push(`unsupported events (${d.invalidEventKeys.join(", ")})`);
    }
    if (d.pluginIssues && d.pluginIssues.length > 0) {
      // Plugin issues already name their file; render them as-is.
      return d.pluginIssues.join("; ");
    }
    return `${d.settingsFile}: ${bits.join("; ")}`;
  });
  for (const id of unwired) {
    const what = ADAPTER_SPECS[id].installMode === "opencode-plugin" ? "plugin" : "hooks";
    parts.push(`${ADAPTER_SPECS[id].settingsFile}: ${id} CLI installed, no harnery ${what} wired`);
  }
  const needsManualRepair = drift.some(
    (d) =>
      d.parseError ||
      d.invalidTopLevelKeys.length > 0 ||
      d.invalidEventKeys.length > 0 ||
      d.pluginIssues?.some((issue) => issue.includes("without harnery's ownership header")),
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
  return {
    name: "adapter hooks",
    scope: "runtime",
    severity: "warn",
    detail: parts.join("  |  "),
    hint,
  };
}

function macOrLinux(mac: string, linux: string): string {
  return os.platform() === "darwin" ? mac : linux;
}
