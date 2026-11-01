// `computer`: opt-in desktop control through one pinned desktop driver
// (ADR 0228). The driver adapter (src/lib/computer/cua.ts), host detection and
// the cross-call desktop lease live in src/lib/computer/; this command owns
// the config gate, flag parsing, lease policy for `call`, screenshot redaction,
// rendering, and exit codes.
//
// Exit codes: 0 ok · 1 error (disabled, unsupported host, not installed,
// driver failure; `call` propagates the driver's own exit code) · 3 the
// desktop lease is held by another agent.

import { hostname, userInfo } from "node:os";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { resolveCoordRoot, resolveOwner } from "../core/agents/coord-client.ts";
import { agentDisplayName, resolveShortName } from "../core/agents/state/activity-log.ts";
import { type ComputerProjectConfig, readComputerConfig } from "../core/config.ts";
import type {
  DaemonStatus,
  DesktopDriver,
  DesktopLease,
  DriverCallResult,
  HostInfo,
  LeaseApi,
  LeaseOptions,
  LeaseOwner,
} from "../lib/computer/types.ts";

/** Exit code for a desktop held by another agent. */
export const EXIT_LEASE_HELD = 3;
/** `call` waits this long for another agent's lease when nothing overrides it. */
export const DEFAULT_CALL_WAIT_SECONDS = 30;

/** Everything the command touches outside itself; tests inject fakes. */
export interface ComputerDeps {
  emit: EmitContext;
  binName: string;
  host: () => HostInfo;
  driver: DesktopDriver;
  lease: LeaseApi;
  owner: () => LeaseOwner;
  config: () => ComputerProjectConfig;
  /** Lease directory for a desktop state dir. */
  leaseDir: (desktopStateDir: string) => string;
  /** Idle expiry when config sets none. */
  defaultIdleMs: number;
  /** Driver stderr passthrough. */
  writeStderr: (text: string) => void;
  now: () => number;
}

export type ComputerDepsInput = Pick<ComputerDeps, "emit" | "binName"> & Partial<ComputerDeps>;

/**
 * Who is asking for the desktop: the coordinated agent when one is resolvable,
 * else the calling OS user (`shell:<user>@<hostname>`, label `shell-<user>`), so
 * separate shell invocations by the same person share one lease.
 */
export function resolveLeaseOwner(): LeaseOwner {
  const root = resolveCoordRoot();
  const id = resolveOwner();
  if (id) {
    return {
      id,
      label: root ? resolveShortName(root, id) : agentDisplayName(id),
      ...(root ? { project: root } : {}),
    };
  }
  const user = userInfo().username;
  return {
    id: `shell:${user}@${hostname()}`,
    label: `shell-${user}`,
    ...(root ? { project: root } : {}),
  };
}

async function loadDefaultDeps(): Promise<
  Pick<ComputerDeps, "host" | "driver" | "lease" | "leaseDir" | "defaultIdleMs">
> {
  const [{ detectHost }, { cuaDriver }, { desktopLease, leaseDir, DEFAULT_LEASE_IDLE_MS }] =
    await Promise.all([
      import("../lib/computer/host.ts"),
      import("../lib/computer/cua.ts"),
      import("../lib/computer/lease.ts"),
    ]);
  return {
    host: () => detectHost(),
    driver: cuaDriver,
    lease: desktopLease,
    leaseDir,
    defaultIdleMs: DEFAULT_LEASE_IDLE_MS,
  };
}

/** Fill in every dependency the caller did not inject; driver modules load lazily. */
async function resolveDeps(input: ComputerDepsInput): Promise<ComputerDeps> {
  const needsDefaults =
    !input.host ||
    !input.driver ||
    !input.lease ||
    !input.leaseDir ||
    input.defaultIdleMs === undefined;
  const defaults = needsDefaults ? await loadDefaultDeps() : undefined;
  return {
    emit: input.emit,
    binName: input.binName,
    host: input.host ?? (defaults?.host as ComputerDeps["host"]),
    driver: input.driver ?? (defaults?.driver as DesktopDriver),
    lease: input.lease ?? (defaults?.lease as LeaseApi),
    leaseDir: input.leaseDir ?? (defaults?.leaseDir as ComputerDeps["leaseDir"]),
    defaultIdleMs: input.defaultIdleMs ?? (defaults?.defaultIdleMs as number),
    owner: input.owner ?? resolveLeaseOwner,
    config: input.config ?? (() => readComputerConfig()),
    writeStderr: input.writeStderr ?? ((text) => process.stderr.write(text)),
    now: input.now ?? Date.now,
  };
}

class ComputerError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
    readonly hint?: string,
  ) {
    super(message);
  }
}

function enableHint(): string {
  return 'Add `"computer": { "enabled": true }` to .harnery/config.jsonc to enable it for this project.';
}

function requireEnabled(deps: ComputerDeps): void {
  if (deps.config().enabled) return;
  throw new ComputerError(
    "computer_disabled",
    `Computer use is off in this project. ${enableHint()}`,
  );
}

type SupportedHost = HostInfo & { desktopStateDir: string };

function requireSupported(host: HostInfo): SupportedHost {
  if (host.kind === "unsupported" || !host.desktopStateDir) {
    throw new ComputerError(
      "computer_unsupported_host",
      `Computer use is not available on this host: ${host.reason ?? "no supported desktop driver build"}`,
    );
  }
  return host as SupportedHost;
}

function requireInstalled(deps: ComputerDeps, host: HostInfo): string {
  const exe = deps.driver.installedExecutable(host);
  if (exe) return exe;
  throw new ComputerError(
    "computer_not_installed",
    `The pinned desktop driver (${deps.driver.id} ${deps.driver.version}) is not installed. Run \`${deps.binName} computer install --yes\`.`,
  );
}

function leaseOptions(deps: ComputerDeps, host: SupportedHost, waitMs = 0): LeaseOptions {
  const idleSeconds = deps.config().idle_seconds;
  return {
    dir: deps.leaseDir(host.desktopStateDir),
    idleMs: idleSeconds !== undefined ? Math.round(idleSeconds * 1000) : deps.defaultIdleMs,
    waitMs,
    now: deps.now,
  };
}

function expiresInSeconds(lease: DesktopLease, nowMs: number): number {
  return Math.max(0, Math.ceil((Date.parse(lease.expires_at) - nowMs) / 1000));
}

function describeLease(lease: DesktopLease, nowMs: number): string {
  return `${lease.owner_label} (generation ${lease.generation}, idle-expires in ${expiresInSeconds(lease, nowMs)}s)`;
}

function heldError(deps: ComputerDeps, holder: DesktopLease): ComputerError {
  return new ComputerError(
    "computer_lease_held",
    `Desktop is held by ${describeLease(holder, deps.now())}. Wait, or ask them to run \`${deps.binName} computer lease release\`.`,
    EXIT_LEASE_HELD,
  );
}

function parseSeconds(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 3600) {
    throw new ComputerError("computer_usage", `${flag} must be a number of seconds from 0 to 3600`);
  }
  return value;
}

function parseCallArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ComputerError(
      "computer_usage",
      `Tool arguments must be JSON: ${(err as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ComputerError("computer_usage", "Tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

const PNG_B64_RE = /"([A-Za-z0-9_]*png_b64)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

/**
 * Replace inline base64 screenshots in driver output with a short note, so a
 * single state read cannot flood the calling agent's context. Works on the raw
 * text, so the driver's formatting survives.
 */
export function redactInlineScreenshots(stdout: string): string {
  return stdout.replace(
    PNG_B64_RE,
    (_match, key: string, sep: string, value: string) =>
      `"${key}"${sep}"<omitted ${value.length} chars; pass screenshot_out_file or --keep-screenshot>"`,
  );
}

function printDriverResult(deps: ComputerDeps, result: DriverCallResult, stdout = result.stdout) {
  if (stdout) emitLine(deps.emit, stdout);
  if (result.stderr)
    deps.writeStderr(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  if (result.exitCode !== 0) deps.emit.setExitCode(result.exitCode);
}

async function ensureDaemon(deps: ComputerDeps, host: HostInfo): Promise<DaemonStatus> {
  const current = deps.driver.daemonStatus(host);
  if (current.running) return current;
  const started = await deps.driver.startDaemon(host);
  if (!started.running) {
    throw new ComputerError(
      "computer_daemon_failed",
      `The desktop driver daemon did not start${started.detail ? `: ${started.detail}` : "."}`,
    );
  }
  return started;
}

/** Write human-readable text, ending it with exactly one newline. */
function emitLine(emit: { text(s: string): void }, s: string): void {
  emit.text(s.endsWith("\n") ? s : `${s}\n`);
}

/** Run one action, turning a ComputerError (or any throw) into emit.error + exit code. */
function guarded<A extends unknown[]>(
  input: ComputerDepsInput,
  body: (deps: ComputerDeps, ...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const deps = await resolveDeps(input);
    try {
      await body(deps, ...args);
    } catch (err) {
      if (err instanceof ComputerError) {
        deps.emit.error({
          code: err.code,
          message: err.message,
          ...(err.hint ? { hint: err.hint } : {}),
        });
        deps.emit.setExitCode(err.exitCode);
        return;
      }
      deps.emit.error({ code: "computer_error", message: (err as Error).message ?? String(err) });
      deps.emit.setExitCode(1);
    }
  };
}

interface DoctorCheck {
  name: string;
  status: string;
  message?: string;
}

/** Pull `{name, status, message}` checks out of the driver's health report, leniently. */
function healthChecks(json: unknown): DoctorCheck[] | undefined {
  const source = Array.isArray(json)
    ? json
    : json && typeof json === "object"
      ? (json as Record<string, unknown>).checks
      : undefined;
  const toCheck = (name: string, value: unknown): DoctorCheck | undefined => {
    if (!value || typeof value !== "object") return undefined;
    const record = value as Record<string, unknown>;
    const status =
      record.status ??
      record.state ??
      (record.ok === true ? "pass" : record.ok === false ? "fail" : undefined);
    if (typeof status !== "string") return undefined;
    const message = record.message ?? record.detail;
    return {
      name: typeof record.name === "string" ? record.name : name,
      status,
      ...(typeof message === "string" ? { message } : {}),
    };
  };
  if (Array.isArray(source)) {
    const checks = source
      .map((value, i) => toCheck(`check-${i + 1}`, value))
      .filter((c): c is DoctorCheck => c !== undefined);
    return checks.length > 0 ? checks : undefined;
  }
  if (source && typeof source === "object") {
    const checks = Object.entries(source as Record<string, unknown>)
      .map(([name, value]) => toCheck(name, value))
      .filter((c): c is DoctorCheck => c !== undefined);
    return checks.length > 0 ? checks : undefined;
  }
  return undefined;
}

// "skip" is a check that does not apply on this platform, not a failure.
const PASSING = new Set(["pass", "passed", "ok", "healthy", "success", "skip", "skipped", "info"]);

/**
 * Build the `computer` command tree under `parent` (a fresh root when omitted)
 * and return it. Tests pass fakes for host/driver/lease/owner/config.
 */
export function createComputerCommand(
  input: ComputerDepsInput,
  parent: Command = new Command(),
): Command {
  const bin = input.binName;
  const computer = parent
    .command("computer")
    .description(
      "Opt-in desktop control through a pinned desktop driver: install it, run its daemon, " +
        "and call its tools while holding a desktop lease shared by every agent on this machine.",
    )
    .addHelpText(
      "after",
      `\nEnable per project with "computer": { "enabled": true } in .harnery/config.jsonc.\n` +
        `Exit codes: 0 ok · 1 error · ${EXIT_LEASE_HELD} desktop held by another agent.\n` +
        `Start with \`${bin} computer status\`.`,
    );

  // ------------------------------------------------------------------ status
  computer
    .command("status")
    .description(
      "Show the host, pinned driver, install, daemon, desktop lease holder, and enabled flag.",
    )
    .option("--json", "Emit the status as JSON.")
    .action(
      guarded(input, (deps, opts: { json?: boolean }) => {
        const config = deps.config();
        const host = deps.host();
        const supported = host.kind !== "unsupported" && Boolean(host.desktopStateDir);
        const installed = supported ? (deps.driver.installedExecutable(host) ?? null) : null;
        let daemon: DaemonStatus | null = null;
        if (installed) {
          try {
            daemon = deps.driver.daemonStatus(host);
          } catch (err) {
            daemon = { running: false, detail: (err as Error).message };
          }
        }
        const lease = supported ? deps.lease.read(leaseOptions(deps, host as SupportedHost)) : null;
        const nowMs = deps.now();
        if (opts.json) {
          deps.emit.data({
            enabled: config.enabled,
            host: { kind: host.kind, ...(host.reason ? { reason: host.reason } : {}) },
            driver: { id: deps.driver.id, version: deps.driver.version },
            installed,
            daemon,
            lease: lease ? { ...lease, expires_in_seconds: expiresInSeconds(lease, nowMs) } : null,
          });
          return;
        }
        const lines = [
          `enabled:   ${config.enabled ? "yes" : `no (${enableHint()})`}`,
          `host:      ${host.kind}${host.reason ? ` (${host.reason})` : ""}`,
          `driver:    ${deps.driver.id} ${deps.driver.version} (pinned)`,
        ];
        if (supported) {
          lines.push(`installed: ${installed ?? "not installed"}`);
          lines.push(
            `daemon:    ${
              daemon
                ? daemon.running
                  ? `running${daemon.pid !== undefined ? ` (pid ${daemon.pid})` : ""}`
                  : `stopped${daemon.detail ? ` (${daemon.detail})` : ""}`
                : "n/a"
            }`,
          );
          lines.push(`lease:     ${lease ? `held by ${describeLease(lease, nowMs)}` : "free"}`);
        }
        emitLine(deps.emit, lines.join("\n"));
      }),
    );

  // ----------------------------------------------------------------- install
  computer
    .command("install")
    .description(
      "Preview the pinned driver install (URL, SHA-256, install dir, preference file); --yes downloads, verifies, and installs it.",
    )
    .option("--yes", "Apply the install. Without it, only the plan is shown.")
    .option("--json", "Emit the plan or result as JSON.")
    .action(
      guarded(input, async (deps, opts: { yes?: boolean; json?: boolean }) => {
        requireEnabled(deps);
        const host = requireSupported(deps.host());
        const plan = deps.driver.planInstall(host);
        if (!opts.yes) {
          if (opts.json) {
            deps.emit.data({ applied: false, plan });
            return;
          }
          emitLine(
            deps.emit,
            [
              `${plan.alreadyInstalled ? "Already installed" : "Would install"}: ${plan.driver} ${plan.version} for ${plan.host}`,
              `  url:          ${plan.artifact.url}`,
              `  sha256:       ${plan.artifact.sha256}`,
              `  install dir:  ${plan.installDir}`,
              `  executable:   ${plan.executable}`,
              `  preferences:  ${plan.preferenceFile} ${JSON.stringify(plan.preferences)}`,
              plan.alreadyInstalled
                ? "Nothing to do."
                : `Re-run with --yes to install: \`${deps.binName} computer install --yes\`.`,
            ].join("\n"),
          );
          return;
        }
        const result = await deps.driver.install(plan);
        if (opts.json) {
          deps.emit.data({ applied: true, result });
          return;
        }
        emitLine(
          deps.emit,
          result.installed
            ? `Installed ${result.driver} ${result.version} at ${result.executable}.\nStart it with \`${deps.binName} computer up\`.`
            : `${result.driver} ${result.version} was already installed at ${result.executable}.`,
        );
      }),
    );

  // ---------------------------------------------------------------- up/down
  computer
    .command("up")
    .description("Start the desktop driver daemon (unelevated) if it is not running.")
    .action(
      guarded(input, async (deps) => {
        requireEnabled(deps);
        const host = requireSupported(deps.host());
        requireInstalled(deps, host);
        const status = await ensureDaemon(deps, host);
        emitLine(
          deps.emit,
          `Daemon running${status.pid !== undefined ? ` (pid ${status.pid})` : ""}.`,
        );
      }),
    );

  computer
    .command("down")
    .description("Stop the desktop driver daemon.")
    .action(
      guarded(input, (deps) => {
        const host = requireSupported(deps.host());
        requireInstalled(deps, host);
        const status = deps.driver.stopDaemon(host);
        emitLine(
          deps.emit,
          status.running ? `Daemon still running: ${status.detail}` : "Daemon stopped.",
        );
        if (status.running) deps.emit.setExitCode(1);
      }),
    );

  // ------------------------------------------------------------------ doctor
  computer
    .command("doctor")
    .description("Run the driver's own health report; any non-passing check exits 1.")
    .option("--json", "Emit the checks as JSON.")
    .action(
      guarded(input, (deps, opts: { json?: boolean }) => {
        const host = requireSupported(deps.host());
        requireInstalled(deps, host);
        const result = deps.driver.health(host);
        let json = result.json;
        if (json === undefined) {
          try {
            json = JSON.parse(result.stdout);
          } catch {
            json = undefined;
          }
        }
        const checks = healthChecks(json);
        const failing = checks?.filter((c) => !PASSING.has(c.status.toLowerCase())) ?? [];
        const ok = result.exitCode === 0 && checks !== undefined && failing.length === 0;
        if (opts.json) {
          deps.emit.data({
            ok,
            exit_code: result.exitCode,
            checks: checks ?? null,
            report: json ?? result.stdout,
          });
        } else if (checks) {
          emitLine(
            deps.emit,
            checks
              .map((c) => `${c.status.padEnd(6)} ${c.name}${c.message ? `: ${c.message}` : ""}`)
              .join("\n"),
          );
        } else {
          if (result.stdout) emitLine(deps.emit, result.stdout);
          emitLine(deps.emit, "No structured checks in the driver's health report.");
        }
        if (result.stderr) deps.writeStderr(result.stderr);
        if (!ok) deps.emit.setExitCode(1);
      }),
    );

  // ---------------------------------------------------------- tools/describe
  computer
    .command("tools")
    .description("List the driver's tools (name: description).")
    .action(
      guarded(input, (deps) => {
        const host = requireSupported(deps.host());
        requireInstalled(deps, host);
        printDriverResult(deps, deps.driver.listTools(host));
      }),
    );

  computer
    .command("describe <tool>")
    .description("Show one tool's description and input schema.")
    .action(
      guarded(input, (deps, tool: string) => {
        const host = requireSupported(deps.host());
        requireInstalled(deps, host);
        printDriverResult(deps, deps.driver.describe(host, tool));
      }),
    );

  // -------------------------------------------------------------------- call
  computer
    .command("call <tool> [json]")
    .description(
      "Call one driver tool with a JSON object of arguments, holding the desktop lease. " +
        "`session` defaults to your agent name; inline base64 screenshots are redacted unless --keep-screenshot.",
    )
    .option(
      "--wait <seconds>",
      "How long to wait for another agent's lease (default: config wait_seconds or 30).",
    )
    .option("--keep-screenshot", "Print inline base64 screenshots instead of redacting them.")
    .action(
      guarded(
        input,
        async (
          deps,
          tool: string,
          rawJson: string | undefined,
          opts: { wait?: string; keepScreenshot?: boolean },
        ) => {
          requireEnabled(deps);
          const host = requireSupported(deps.host());
          requireInstalled(deps, host);
          const args = parseCallArgs(rawJson);
          const waitSeconds =
            parseSeconds(opts.wait, "--wait") ??
            deps.config().wait_seconds ??
            DEFAULT_CALL_WAIT_SECONDS;
          const owner = deps.owner();
          if (!("session" in args)) args.session = owner.label;

          const acquired = await deps.lease.acquire(
            owner,
            leaseOptions(deps, host, Math.round(waitSeconds * 1000)),
          );
          if (!acquired.ok) throw heldError(deps, acquired.holder);

          await ensureDaemon(deps, host);
          const translated = deps.driver.translateArgsPaths(host, tool, args);
          const result = deps.driver.call(host, tool, translated);
          let stdout = deps.driver.translateResultPaths(host, result.stdout);
          if (!opts.keepScreenshot) stdout = redactInlineScreenshots(stdout);
          printDriverResult(deps, result, stdout);
        },
      ),
    );

  // ------------------------------------------------------------------- lease
  const lease = computer
    .command("lease")
    .description(
      "Inspect, take, or release the desktop lease shared by every agent on this machine.",
    );

  lease
    .command("status")
    .description("Show the current desktop lease holder, or that the desktop is free.")
    .option("--json", "Emit the lease as JSON (null when free).")
    .action(
      guarded(input, (deps, opts: { json?: boolean }) => {
        const host = requireSupported(deps.host());
        const current = deps.lease.read(leaseOptions(deps, host));
        const nowMs = deps.now();
        if (opts.json) {
          deps.emit.data({
            lease: current
              ? { ...current, expires_in_seconds: expiresInSeconds(current, nowMs) }
              : null,
          });
          return;
        }
        emitLine(deps.emit, current ? `held by ${describeLease(current, nowMs)}` : "free");
      }),
    );

  lease
    .command("acquire")
    .description("Take (or refresh) the desktop lease for yourself without calling a tool.")
    .option("--wait <seconds>", "How long to wait for another agent's lease (default 0).")
    .action(
      guarded(input, async (deps, opts: { wait?: string }) => {
        requireEnabled(deps);
        const host = requireSupported(deps.host());
        const waitSeconds = parseSeconds(opts.wait, "--wait") ?? 0;
        const result = await deps.lease.acquire(
          deps.owner(),
          leaseOptions(deps, host, Math.round(waitSeconds * 1000)),
        );
        if (!result.ok) throw heldError(deps, result.holder);
        emitLine(
          deps.emit,
          `${result.fresh ? "Acquired" : "Refreshed"} the desktop lease: ${describeLease(result.lease, deps.now())}.`,
        );
      }),
    );

  lease
    .command("release")
    .description("Release the desktop lease if you hold it.")
    .action(
      guarded(input, (deps) => {
        const host = requireSupported(deps.host());
        const owner = deps.owner();
        const released = deps.lease.release(owner, leaseOptions(deps, host));
        if (released) {
          emitLine(deps.emit, `Released the desktop lease held by ${owner.label}.`);
          return;
        }
        const current = deps.lease.read(leaseOptions(deps, host));
        if (!current) {
          emitLine(deps.emit, "The desktop was not leased.");
          return;
        }
        throw new ComputerError(
          "computer_lease_held",
          `Not released: the desktop is held by ${describeLease(current, deps.now())}, not ${owner.label}.`,
          EXIT_LEASE_HELD,
        );
      }),
    );

  return computer;
}

export function registerComputerCommand(
  program: Command,
  emit: EmitContext,
  binName: string,
): void {
  createComputerCommand({ emit, binName }, program);
}
