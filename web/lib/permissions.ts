/**
 * Data and plain-English wording for the Permissions page: what the coding
 * agents on this computer may do. Read through `harn permissions --json` and
 * `harn computer status --json`, so the page shows what the CLI reports.
 *
 * The page's writes, the person's own computer-use mode and agent sign-in
 * choice for this project, also go through the CLI (`harn computer mode`,
 * `harn computer sign-in`), and only from a request made on this computer:
 * see `requestLocality`.
 */

import type { PermissionsReport } from "../../src/core/permissions";
import { type HarnResult, runHarn } from "./run-harn";
import { checkWriteOrigin } from "./write-origin";

export type { PermissionsReport };

export interface ComputerStatus {
  enabled: boolean;
  mode: string;
  project_mode: string;
  mode_source: string;
  config_error?: string;
  /** Agents may sign in to websites for this person (older CLIs omit these). */
  sign_in?: boolean;
  project_sign_in?: boolean;
  sign_in_source?: string;
  host: { kind: string; reason?: string; note?: string };
  default_driver: string | null;
  drivers: Array<{
    id: string;
    version: string;
    summary: string;
    installed: string | null;
    daemon: { running: boolean; detail?: string } | null;
  }>;
  lease: {
    owner_label?: string;
    owner_id?: string;
    acquired_at?: string;
    expires_at?: string;
  } | null;
}

/** The line that says what went wrong, not Node's closing version banner or a stack frame. */
function errorLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^Node\.js v\d/.test(l) && !/^at /.test(l));
  return lines.find((l) => /error/i.test(l)) ?? lines.pop() ?? "";
}

async function json<T>(args: string[], timeoutMs: number): Promise<{ value?: T; error?: string }> {
  const result = await runHarn(args, { timeoutMs });
  try {
    return { value: JSON.parse(result.stdout) as T };
  } catch {
    return { error: errorLine(result.stderr) || `harn ${args.join(" ")} gave no answer` };
  }
}

export async function readPermissionsPage(): Promise<{
  permissions?: PermissionsReport;
  permissionsError?: string;
  computer?: ComputerStatus;
  computerError?: string;
}> {
  const [permissions, computer] = await Promise.all([
    json<PermissionsReport>(["permissions", "--json"], 45_000),
    json<ComputerStatus>(["computer", "status", "--json"], 30_000),
  ]);
  return {
    permissions: permissions.value,
    permissionsError: permissions.error,
    computer: computer.value,
    computerError: computer.error,
  };
}

/** What each setting value means for the person, in one sentence. */
export const MEANINGS = {
  computerMode: {
    off: "Agents cannot use this computer's screen, mouse or keyboard.",
    "ask-each-task":
      "An agent asks you with a Yes/No pop-up before each task on the screen; the approval ends with the task.",
    "ask-once-per-session":
      "An agent asks you once; that approval lasts for the rest of its session.",
    on: "Agents use the screen without asking.",
  } as Record<string, string>,
  claudeMode: {
    default:
      "Claude Code asks before editing files or running commands that are not on its allowed list.",
    acceptEdits:
      "Claude Code edits files without asking, and asks before running commands not on its allowed list.",
    plan: "Claude Code only plans; it does not edit files or run commands until you approve the plan.",
    auto: "Claude Code decides for itself which steps need your approval.",
    dontAsk: "Claude Code never asks; anything not on its allowed list is refused.",
    bypassPermissions: "Claude Code does everything without asking.",
  } as Record<string, string>,
  codexPolicy: {
    untrusted: "Codex asks before running any command it does not consider safe.",
    "on-request": "Codex decides when to ask you.",
    "on-failure": "Codex asks only when a command fails inside its sandbox.",
    never: "Codex never asks.",
  } as Record<string, string>,
  codexSandbox: {
    "read-only": "Codex can read files but not change them.",
    "workspace-write": "Codex can change files inside the project only.",
    "danger-full-access": "Codex can change any file and use the network, with no sandbox.",
  } as Record<string, string>,
  codexHookTrust: {
    trusted: "approved",
    untrusted: "waiting for approval",
    modified: "changed since it was approved",
    managed: "set by an administrator",
  } as Record<string, string>,
  cursorApproval: {
    allowlist: "Cursor runs commands on its allowed list and asks about the rest.",
    "run-everything": "Cursor runs every command without asking.",
  } as Record<string, string>,
  cursorSandbox: {
    disabled: "Cursor's commands run without a sandbox.",
    enabled: "Cursor's commands run in a sandbox.",
  } as Record<string, string>,
};

// ------------------------------------------------------------------ changing your own mode

/**
 * The computer-use modes, strictest first. Mirrors `COMPUTER_MODES` in the
 * CLI's config (a test keeps them equal); kept here so the dashboard does not
 * pull the CLI's config module into its bundle.
 */
export const COMPUTER_MODES = ["off", "ask-each-task", "ask-once-per-session", "on"] as const;
export type ComputerMode = (typeof COMPUTER_MODES)[number];

/** The page's choice that removes the person's own mode for this project. */
export const PROJECT_DEFAULT_CHOICE = "default";
export type ComputerModeChoice = ComputerMode | typeof PROJECT_DEFAULT_CHOICE;

/** Short button labels for each mode. */
export const COMPUTER_MODE_LABELS: Record<ComputerMode, string> = {
  off: "Off",
  "ask-each-task": "Ask each task",
  "ask-once-per-session": "Ask once per session",
  on: "On",
};

/**
 * How long the CLI's confirmation pop-up waits for an answer. Mirrors
 * `DEFAULT_CONFIRM_SECONDS` in the computer command (a test keeps them equal).
 */
export const CONFIRM_SECONDS = 120;

/** How long the dashboard lets `harn computer mode` run: the pop-up's wait plus headroom. */
export const MODE_CHANGE_TIMEOUT_MS = (CONFIRM_SECONDS + 30) * 1000;

export function isComputerMode(value: unknown): value is ComputerMode {
  return typeof value === "string" && (COMPUTER_MODES as readonly string[]).includes(value);
}

/** True when mode `a` asks for less approval than mode `b`. */
export function computerModeLooser(a: ComputerMode, b: ComputerMode): boolean {
  return COMPUTER_MODES.indexOf(a) > COMPUTER_MODES.indexOf(b);
}

/** The agent sign-in choices: off, on, or back to the default (off). */
export const SIGN_IN_CHOICES = ["off", "on", PROJECT_DEFAULT_CHOICE] as const;
export type SignInChoice = (typeof SIGN_IN_CHOICES)[number];

export const SIGN_IN_MEANINGS: Record<"off" | "on", string> = {
  off: "You sign in to websites yourself when an agent needs it.",
  on: "Agents sign in to websites for you in your own browser by choosing your login in your password manager's extension. A locked password manager, a passkey or a code sent to you still comes to you.",
};

/** Validate a sign-in change request body: exactly `{ "sign_in": "on" | "off" | "default" }`. */
export function parseSignInChangeRequest(
  body: unknown,
): { ok: true; choice: SignInChoice } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: 'Send the new choice as { "sign_in": "..." }.' };
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "sign_in") {
    return { ok: false, message: "Send only the new choice." };
  }
  const value = (body as { sign_in: unknown }).sign_in;
  if ((SIGN_IN_CHOICES as readonly unknown[]).includes(value)) {
    return { ok: true, choice: value as SignInChoice };
  }
  return { ok: false, message: `The choice must be one of ${SIGN_IN_CHOICES.join(", ")}.` };
}

/** The CLI arguments for one validated sign-in choice. Always this project, never every project. */
export function signInChangeArgs(choice: SignInChoice): string[] {
  return choice === PROJECT_DEFAULT_CHOICE
    ? ["computer", "sign-in", "--clear", "--json"]
    : ["computer", "sign-in", choice, "--json"];
}

/** Validate a change request body: exactly `{ "mode": <mode or "default"> }`. */
export function parseModeChangeRequest(
  body: unknown,
): { ok: true; choice: ComputerModeChoice } | { ok: false; message: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: 'Send the new mode as { "mode": "..." }.' };
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "mode") {
    return { ok: false, message: "Send only the new mode." };
  }
  const mode = (body as { mode: unknown }).mode;
  if (mode === PROJECT_DEFAULT_CHOICE || isComputerMode(mode)) return { ok: true, choice: mode };
  return {
    ok: false,
    message: `The mode must be one of ${[...COMPUTER_MODES, PROJECT_DEFAULT_CHOICE].join(", ")}.`,
  };
}

/** The CLI arguments for one validated choice. Always this project, never every project. */
export function modeChangeArgs(choice: ComputerModeChoice): string[] {
  return choice === PROJECT_DEFAULT_CHOICE
    ? ["computer", "mode", "--clear", "--json"]
    : ["computer", "mode", choice, "--json"];
}

export type ModeChangeOutcome =
  | { outcome: "changed"; mode?: string; message: string }
  | {
      outcome: "declined" | "timed-out" | "unavailable" | "refused" | "busy" | "failed";
      message: string;
    };

function cliError(stderr: string): { code?: string; message?: string } {
  for (const line of stderr.split(/\r?\n/).reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { error?: { code?: unknown; message?: unknown } };
      if (parsed.error && typeof parsed.error === "object") {
        return {
          code: typeof parsed.error.code === "string" ? parsed.error.code : undefined,
          message: typeof parsed.error.message === "string" ? parsed.error.message : undefined,
        };
      }
    } catch {
      // not the error line
    }
  }
  return {};
}

/**
 * Turn the CLI's answer into plain words. The CLI reports a "No" and an
 * unanswered pop-up the same way (exit 4, `computer_approval_declined`), so a
 * refusal that took about as long as the pop-up waits counts as unanswered.
 */
export function interpretModeChange(result: HarnResult, elapsedMs: number): ModeChangeOutcome {
  return interpretChange(result, elapsedMs, {
    changed: (stdout) => {
      let mode: string | undefined;
      try {
        const parsed = JSON.parse(stdout) as { mode?: unknown };
        if (typeof parsed.mode === "string") mode = parsed.mode;
      } catch {
        // changed, but with no readable answer
      }
      const meaning = mode ? MEANINGS.computerMode[mode] : undefined;
      return {
        outcome: "changed",
        ...(mode ? { mode } : {}),
        message: mode
          ? `Changed. Your computer-use mode for this project is now ${mode}${meaning ? `: ${meaning}` : "."}`
          : "Changed.",
      };
    },
    refusedCode: "computer_disabled",
    refused:
      "Not changed: this project does not allow agents to use the desktop, and your own mode cannot turn it on.",
    command: "harn computer mode",
  });
}

/** Turn `harn computer sign-in`'s answer into plain words; see `interpretModeChange`. */
export function interpretSignInChange(result: HarnResult, elapsedMs: number): ModeChangeOutcome {
  return interpretChange(result, elapsedMs, {
    changed: (stdout) => {
      let on: boolean | undefined;
      try {
        const parsed = JSON.parse(stdout) as { sign_in?: unknown };
        if (typeof parsed.sign_in === "boolean") on = parsed.sign_in;
      } catch {
        // changed, but with no readable answer
      }
      return {
        outcome: "changed",
        message:
          on === undefined
            ? "Changed."
            : `Changed. ${on ? SIGN_IN_MEANINGS.on : SIGN_IN_MEANINGS.off}`,
      };
    },
    refusedCode: "sign_in_not_allowed",
    refused:
      "Not changed: this project does not let agents sign in for people, and your own choice cannot turn it on.",
    command: "harn computer sign-in",
  });
}

function interpretChange(
  result: HarnResult,
  elapsedMs: number,
  words: {
    changed: (stdout: string) => ModeChangeOutcome;
    refusedCode: string;
    refused: string;
    command: string;
  },
): ModeChangeOutcome {
  if (result.timedOut) {
    return {
      outcome: "timed-out",
      message: "Not changed: the confirmation pop-up got no answer in time.",
    };
  }
  if (result.ok) return words.changed(result.stdout);
  const error = cliError(result.stderr);
  if (error.code === "computer_approval_declined") {
    const noWay = /no way to ask(?: \((.*)\))?/.exec(error.message ?? "");
    if (noWay) {
      return {
        outcome: "unavailable",
        message: `Not changed: the confirmation pop-up could not be shown on this computer${noWay[1] ? ` (${noWay[1]})` : ""}.`,
      };
    }
    if (elapsedMs >= (CONFIRM_SECONDS - 5) * 1000) {
      return {
        outcome: "timed-out",
        message: `Not changed: the confirmation pop-up closed after ${CONFIRM_SECONDS / 60} minutes without an answer.`,
      };
    }
    return {
      outcome: "declined",
      message: "Not changed: you answered No in the confirmation pop-up.",
    };
  }
  if (error.code === words.refusedCode) {
    return { outcome: "refused", message: words.refused };
  }
  return {
    outcome: "failed",
    message: `Not changed: ${error.message ?? (errorLine(result.stderr) || `${words.command} gave no answer`)}`,
  };
}

/** Change the person's own mode for this project through the CLI. Call only after `checkLocalWrite`. */
export async function changeComputerMode(choice: ComputerModeChoice): Promise<ModeChangeOutcome> {
  const started = Date.now();
  const result = await runHarn(modeChangeArgs(choice), { timeoutMs: MODE_CHANGE_TIMEOUT_MS });
  return interpretModeChange(result, Date.now() - started);
}

/** Change the person's own agent sign-in choice for this project. Call only after `checkLocalWrite`. */
export async function changeSignIn(choice: SignInChoice): Promise<ModeChangeOutcome> {
  const started = Date.now();
  const result = await runHarn(signInChangeArgs(choice), { timeoutMs: MODE_CHANGE_TIMEOUT_MS });
  return interpretSignInChange(result, Date.now() - started);
}

// ------------------------------------------------------------------ local requests only

/** A header reader: `Headers`, or Next's `ReadonlyHeaders`. */
export interface HeaderSource {
  get(name: string): string | null;
}

/** Headers only a proxy or tunnel adds: Cloudflare and Tailscale identify their visitors with these. */
const REMOTE_ONLY_HEADERS = [
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cdn-loop",
  "true-client-ip",
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-funnel-request",
];

/** The hostname of a Host-style value (`name`, `name:port`, `[v6]:port`), lowercased. */
function hostnameOf(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.startsWith("[")) return v.slice(1, v.indexOf("]") > 0 ? v.indexOf("]") : undefined);
  const colons = v.split(":").length - 1;
  return colons === 1 ? v.slice(0, v.indexOf(":")) : v;
}

/** An address on this computer: 127.0.0.0/8, ::1, or IPv4-mapped 127.x. */
export function isLoopbackAddress(value: string): boolean {
  const v = value
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const v4 = v.startsWith("::ffff:") ? v.slice(7) : v;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  return v === "::1" || v === "0:0:0:0:0:0:0:1";
}

/**
 * A Host value naming this computer. Only `localhost` itself: other
 * `*.localhost` names (the dashboard's files origin) serve untrusted pages.
 */
export function isLoopbackHost(value: string): boolean {
  const name = hostnameOf(value);
  return name === "localhost" || isLoopbackAddress(name);
}

function list(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether a request came from a browser on this computer.
 *
 * The dashboard listens on 127.0.0.1 only, so anyone elsewhere reaches it
 * through a local proxy: `harn tunnel`'s gate keeps Host as `localhost` but
 * records the public name in X-Forwarded-Host, and Cloudflare and Tailscale
 * add their own visitor headers and X-Forwarded-For. Next fills
 * X-Forwarded-Host and X-Forwarded-For from the real Host and socket when a
 * request has none, so a direct local request still passes.
 */
export function requestLocality(
  h: HeaderSource,
): { local: true } | { local: false; reason: string } {
  const remote = { local: false as const, reason: "This request did not come from this computer." };
  const host = h.get("host");
  if (!host || !isLoopbackHost(host)) return remote;
  for (const name of REMOTE_ONLY_HEADERS) {
    if (h.get(name) !== null) return remote;
  }
  if (!list(h.get("x-forwarded-host")).every(isLoopbackHost)) return remote;
  if (!list(h.get("x-forwarded-for")).every(isLoopbackAddress)) return remote;
  if (!list(h.get("x-real-ip")).every(isLoopbackAddress)) return remote;
  for (const element of list(h.get("forwarded"))) {
    for (const pair of element.split(";")) {
      const [key, raw = ""] = pair.split("=");
      const value = raw.trim().replace(/^"|"$/g, "");
      const k = key?.trim().toLowerCase();
      if (k === "for" && !isLoopbackAddress(value)) return remote;
      if (k === "host" && !isLoopbackHost(value)) return remote;
    }
  }
  return { local: true };
}

/**
 * A change must come from this computer and from the dashboard's own page:
 * a browser posting from another site (or another local port) is refused.
 */
export function checkLocalWrite(h: HeaderSource): { ok: true } | { ok: false; message: string } {
  const locality = requestLocality(h);
  if (!locality.local) {
    return {
      ok: false,
      message:
        "Not changed: your computer-use settings can be changed only from a browser on this computer.",
    };
  }
  return checkWriteOrigin(h);
}
