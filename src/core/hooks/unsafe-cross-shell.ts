import { isWslUncPath } from "./codex-wsl-bridge.ts";
import type { Adapter } from "./events/schema.ts";

export interface CrossShellInspection {
  adapter: Adapter;
  cwd: unknown;
  toolName: unknown;
  toolInput: unknown;
}

const DENY_REASON =
  "Unsafe Windows-to-WSL shell-string construction blocked. Use the host's argv-preserving " +
  "WSL bridge for a single executable, or its literal-script mode for compound Bash. Do not " +
  "invoke wsl.exe with bash -c or bash -lc.";

function shellCommand(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== "string") return null;
  const normalized = toolName.toLowerCase();
  if (
    normalized !== "bash" &&
    normalized !== "shell" &&
    normalized !== "shell_command" &&
    normalized !== "functions.shell_command"
  ) {
    return null;
  }

  let input = toolInput;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input) as unknown;
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== "object") return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

function quotedToken(command: string, start: number): { token: string; end: number } {
  const quote = command[start]!;
  let token = "";
  for (let index = start + 1; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "`" && quote === '"' && index + 1 < command.length) {
      token += command[index + 1]!;
      index += 1;
      continue;
    }
    if (char === quote) {
      if (quote === "'" && command[index + 1] === "'") {
        token += "'";
        index += 1;
        continue;
      }
      return { token, end: index + 1 };
    }
    token += char;
  }
  return { token, end: command.length };
}

/** Find direct PowerShell command invocations of wsl/wsl.exe outside quoted strings. */
function wslInvocationOffsets(command: string): number[] {
  const offsets: number[] = [];
  let expectCommand = true;
  let callOperator = false;

  for (let index = 0; index < command.length; ) {
    const char = command[index]!;
    if (/\s/.test(char)) {
      if (char === "\n" || char === "\r") {
        expectCommand = true;
        callOperator = false;
      }
      index += 1;
      continue;
    }
    if (char === "#" && expectCommand) {
      const newline = command.indexOf("\n", index + 1);
      index = newline === -1 ? command.length : newline + 1;
      expectCommand = true;
      callOperator = false;
      continue;
    }
    if (";|{}=()".includes(char)) {
      expectCommand = true;
      callOperator = false;
      index += 1;
      continue;
    }
    if (char === "&") {
      expectCommand = true;
      callOperator = true;
      index += command[index + 1] === "&" ? 2 : 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const parsed = quotedToken(command, index);
      if (expectCommand && callOperator && /^wsl(?:\.exe)?$/i.test(parsed.token)) {
        offsets.push(index);
      }
      expectCommand = false;
      callOperator = false;
      index = parsed.end;
      continue;
    }

    const start = index;
    while (index < command.length && !/[\s;|{}=()&]/.test(command[index]!)) index += 1;
    const token = command.slice(start, index);
    if (expectCommand && /^wsl(?:\.exe)?$/i.test(token)) offsets.push(start);
    expectCommand = false;
    callOperator = false;
  }

  return offsets;
}

function statementEnd(command: string, start: number): number {
  let quote: string | null = null;
  for (let index = start; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === "`" && quote === '"') {
        index += 1;
      } else if (char === quote) {
        if (quote === "'" && command[index + 1] === "'") index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === ";" || char === "\n" || char === "\r" || char === "|") return index;
    else if (char === "&" && command[index + 1] === "&") return index;
  }
  return command.length;
}

function invokesBashCommandString(command: string): boolean {
  for (const offset of wslInvocationOffsets(command)) {
    const segment = command.slice(offset, statementEnd(command, offset));
    if (/(?:^|\s)(?:\/bin\/)?bash(?=\s|$)[\s\S]*?\s-[a-z]*c[a-z]*(?=\s|$)/i.test(segment)) {
      return true;
    }
  }
  return false;
}

/**
 * Deny only the unsafe hybrid shape: Windows-native Codex, WSL UNC workspace,
 * shell tool, and a direct wsl.exe -> bash -c/-lc command-string invocation.
 */
export function unsafeCrossShellReason(input: CrossShellInspection): string | null {
  if (input.adapter !== "codex" || !isWslUncPath(input.cwd)) return null;
  const command = shellCommand(input.toolName, input.toolInput);
  if (!command || !invokesBashCommandString(command)) return null;
  return DENY_REASON;
}
