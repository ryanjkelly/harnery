/**
 * Ask the person at this computer to approve something (ADR 0230).
 *
 * One channel that works the same under every agent harness: the approving
 * command asks the person directly instead of relying on a harness approval
 * prompt (some harnesses have none, and full-access sessions skip theirs).
 *
 * - In an interactive terminal, a yes/no prompt there.
 * - Otherwise a native Yes/No dialog on the desktop: Windows (also reached from
 *   WSL through interop), macOS (`osascript`), or a Linux desktop (`zenity`).
 *
 * Silence counts as no: the dialog defaults to the refusing button and closes
 * after `timeoutMs`. An agent with unrestricted access to the same desktop
 * could still answer the dialog itself; this channel stops a well-meaning
 * agent acting unasked, not a determined one.
 *
 * Internal module: not exported from package.json.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { windowsExecutable } from "../windows-executable.ts";
import type { GrantChannel } from "./grants.ts";

export type ConfirmAnswer = "approved" | "denied" | "timed-out" | "unavailable";

export interface ConfirmResult {
  answer: ConfirmAnswer;
  via?: GrantChannel;
  /** Why no channel was available, or what the channel reported. */
  detail?: string;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  timeoutMs: number;
}

export type Confirm = (request: ConfirmRequest) => Promise<ConfirmResult>;

const TEXT_VAR = "HARNERY_CONFIRM_TEXT";
const TITLE_VAR = "HARNERY_CONFIRM_TITLE";

function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function onPath(command: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [command], { stdio: "ignore", windowsHide: true }).status === 0;
}

/**
 * The Windows dialog script: a Yes/No popup with its own timer, so it closes
 * itself when the time is up instead of lingering after the caller gives up.
 * Flags: 4 Yes/No, 48 warning icon, 256 "No" is the default, 4096 always on
 * top. It prints 6 for Yes, 7 for No, and -1 when the timer ran out. The text
 * travels inside the script as base64, not through environment variables,
 * because WSL interop does not reliably pass variables to Windows programs.
 */
export function windowsDialogScript(
  title: string,
  message: string,
  timeoutSeconds: number,
): string {
  const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
  const decode = (s: string) =>
    `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(s)}'))`;
  return [
    `$text = ${decode(message)}`,
    `$title = ${decode(title)}`,
    `$r = (New-Object -ComObject WScript.Shell).Popup($text, ${Math.round(timeoutSeconds)}, $title, 4 + 48 + 256 + 4096)`,
    "Write-Output $r",
  ].join("\n");
}

/** PowerShell's -EncodedCommand form: base64 of the UTF-16LE script. */
export function encodePowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function macDialogScript(timeoutSeconds: number): string {
  return `display dialog (system attribute "${TEXT_VAR}") with title (system attribute "${TITLE_VAR}") buttons {"Deny", "Allow"} default button "Deny" cancel button "Deny" with icon caution giving up after ${timeoutSeconds}`;
}

/** Map one dialog run to an answer. Exported for tests. */
export function interpretDialog(
  kind: "windows" | "mac" | "zenity",
  result: { status: number | null; stdout: string; timedOut: boolean },
): ConfirmAnswer {
  if (result.timedOut) return "timed-out";
  const out = result.stdout.trim();
  if (kind === "windows") {
    if (/^6$/m.test(out)) return "approved";
    return /^-1$/m.test(out) ? "timed-out" : "denied";
  }
  if (kind === "mac") {
    if (/gave up:true/.test(out)) return "timed-out";
    return /button returned:Allow/.test(out) ? "approved" : "denied";
  }
  if (result.status === 0) return "approved";
  return result.status === 5 ? "timed-out" : "denied";
}

function runDialog(request: ConfirmRequest): ConfirmResult {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [TEXT_VAR]: request.message,
    [TITLE_VAR]: request.title,
  };
  const timeoutSeconds = Math.max(5, Math.round(request.timeoutMs / 1000));
  let kind: "windows" | "mac" | "zenity";
  let command: string;
  let args: string[];
  if (process.platform === "win32" || isWsl()) {
    kind = "windows";
    command = windowsExecutable("powershell.exe");
    args = [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodePowerShell(windowsDialogScript(request.title, request.message, timeoutSeconds)),
    ];
  } else if (process.platform === "darwin") {
    kind = "mac";
    command = "osascript";
    args = ["-e", macDialogScript(timeoutSeconds)];
  } else if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && onPath("zenity")) {
    kind = "zenity";
    command = "zenity";
    args = [
      "--question",
      `--title=${request.title}`,
      `--text=${request.message}`,
      "--ok-label=Allow",
      "--cancel-label=Deny",
      `--timeout=${timeoutSeconds}`,
    ];
  } else {
    return {
      answer: "unavailable",
      detail:
        "no desktop dialog is available here (needs Windows, macOS, or a Linux desktop with zenity)",
    };
  }
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout: request.timeoutMs + 5000,
    windowsHide: true,
  });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { answer: "unavailable", detail: `${command} was not found` };
  }
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return {
    answer: interpretDialog(kind, { status: result.status, stdout: result.stdout ?? "", timedOut }),
    via: "dialog",
  };
}

async function askTerminal(request: ConfirmRequest): Promise<ConfirmResult> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), request.timeoutMs);
    rl.question(`\n${request.title}\n\n${request.message}\n\nAllow? [y/N] `, (text) => {
      clearTimeout(timer);
      resolve(text);
    });
  });
  rl.close();
  if (answer === null) return { answer: "timed-out", via: "terminal" };
  return { answer: /^\s*y(es)?\s*$/i.test(answer) ? "approved" : "denied", via: "terminal" };
}

/** Ask in the terminal when one is attached, else with a desktop dialog. */
export const confirmWithPerson: Confirm = async (request) => {
  if (process.stdin.isTTY && process.stderr.isTTY) return askTerminal(request);
  return runDialog(request);
};
