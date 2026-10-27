/**
 * Admission guard for heavy shell checks. A whole-project typecheck, a full
 * test suite, or a production build can each take gigabytes of memory, and
 * several agents starting them at once on one machine can exhaust it. Asking
 * agents in prose to wrap those commands in `admission run` does not work: the
 * rule has to be read and remembered on every call. This guard rewrites the
 * agent's shell command at PreToolUse instead, so each heavy check waits for a
 * slot on a machine-wide admission resource.
 *
 * Enabled only when the project config names a resource
 * (`admission.guard.resource`). It finds each simple command that is a heavy
 * check and inserts `<bin> admission run --resource <name> --label 'agent:
 * ...' --` in front of it, after any leading VAR=value assignments. The rest
 * of the command (cd, pipes, redirects, && chains) is left byte for byte.
 * Heavy means:
 *   - tsc, however launched (tsc, npx/bunx/bun x/pnpm exec/yarn tsc,
 *     node_modules/.bin/tsc, node .../typescript/bin/tsc)
 *   - next build
 *   - bun test with no file or directory named (a full suite)
 *   - the package scripts test / test:* (with no further positional
 *     argument), build, typecheck, type-check, typecheck:*, check-types, tsc,
 *     run through bun run, npm, pnpm, or yarn
 *   - bash/sh -c '<script>' whose script contains one of the above
 * Watch modes, --help/--version, and named-file test runs are left alone.
 *
 * Passes through untouched: non-shell tools; a command that already runs
 * `admission run` or `heavy-slot`; HARNERY_ADMISSION_SKIP=1 in the command or
 * the hook's environment; HARNERY_ADMISSION_HELD in the hook's environment
 * (the session already holds a slot); text inside quotes, heredocs, and
 * comments. Any parse failure means no rewrite.
 */

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "}",
  "fi",
  "done",
  "esac",
]);
const SEPARATORS = new Set([";", "&&", "||", "|", "|&", "&", "(", ")", ";;", ";&", ";;&"]);
const REDIRECTS = ["<<<", "<<-", "&>>", "<<", ">>", ">&", "<&", "&>", "<>", ">|", ">", "<"];
const OPERATORS = [...REDIRECTS, ";;&", ";;", ";&", "&&", "||", "|&"];
const HEAVY_SCRIPTS = /^(build|typecheck|type-check|typecheck:.*|check-types|tsc)$/;
const TEST_SCRIPTS = /^(test|test:.*)$/;
const SHELLS = new Set(["bash", "sh", "dash", "zsh"]);
const SHELL_C_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;
const WATCH_FLAGS = new Set(["-w", "--watch", "--watchAll"]);
const TSC_INFO_FLAGS = new Set([
  "-v",
  "--version",
  "-h",
  "--help",
  "--init",
  "--showConfig",
  "--all",
  "--listFilesOnly",
]);
const BUN_BUILTINS = new Set([
  "test",
  "run",
  "x",
  "build",
  "install",
  "i",
  "add",
  "remove",
  "rm",
  "update",
  "link",
  "unlink",
  "pm",
  "init",
  "create",
  "upgrade",
  "outdated",
  "publish",
  "audit",
  "info",
  "repl",
  "exec",
  "patch",
]);
const BUN_RUN_VALUE_FLAGS = new Set([
  "--cwd",
  "--filter",
  "-F",
  "--elide-lines",
  "--env-file",
  "--config",
  "-c",
  "--preload",
  "-r",
]);
const BUN_TEST_VALUE_FLAGS = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--preload",
  "-r",
  "--coverage-reporter",
  "--coverage-dir",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--seed",
  "--cwd",
  "--env-file",
  "--config",
  "-c",
  "--path-ignore-patterns",
]);
const NPM_VALUE_FLAGS = new Set([
  "-w",
  "--workspace",
  "--prefix",
  "-C",
  "--dir",
  "--filter",
  "-F",
  "--cwd",
]);
const RUNNER_VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call"]);

export const ADMISSION_SKIP_PREFIX = "HARNERY_ADMISSION_SKIP=1";
/** Claude Code's maximum Bash timeout; a queued wait counts against it. */
export const BASH_TIMEOUT_MAX_MS = 600_000;
const LABEL_MAX = 70;

interface Word {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}

type Lexeme = { kind: "word"; word: Word } | { kind: "op"; op: string; start: number };

function baseName(value: string): string {
  return value.split("/").at(-1) ?? value;
}

/**
 * Tokens with source offsets. Quotes stay opaque, heredoc bodies and comments
 * are skipped, and `$(` opens a nested command list.
 */
function lex(src: string): Lexeme[] {
  const out: Lexeme[] = [];
  const n = src.length;
  let heredocs: { end: string; tabs: boolean }[] = [];
  let pendingHeredoc: string | null = null;
  let i = 0;
  while (i < n) {
    const ch = src[i] as string;
    if (ch === "\\" && src[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (ch === "\n") {
      out.push({ kind: "op", op: ";", start: i });
      i += 1;
      for (const doc of heredocs) {
        while (i < n) {
          const found = src.indexOf("\n", i);
          const stop = found === -1 ? n : found;
          const line = src.slice(i, stop);
          i = stop + 1;
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.end) break;
        }
      }
      heredocs = [];
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      const found = src.indexOf("\n", i);
      i = found === -1 ? n : found;
      continue;
    }
    if (ch === "$" && src.startsWith("$(", i) && !src.startsWith("$((", i)) {
      out.push({ kind: "op", op: "(", start: i });
      i += 2;
      continue;
    }
    if (";|&()<>".includes(ch)) {
      const op = OPERATORS.find((candidate) => src.startsWith(candidate, i)) ?? ch;
      out.push({ kind: "op", op, start: i });
      if (op === "<<" || op === "<<-") pendingHeredoc = op;
      i += op.length;
      continue;
    }
    const start = i;
    let value = "";
    let quoted = false;
    while (i < n && !" \t\r\n;|&()<>".includes(src[i] as string)) {
      const c = src[i] as string;
      if (c === "'" || c === '"' || c === "`") {
        quoted = true;
        let close: number;
        if (c === "'") {
          close = src.indexOf(c, i + 1);
        } else {
          let j = i + 1;
          while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
          close = j < n ? j : -1;
        }
        if (close === -1) close = n;
        value += src.slice(i + 1, close);
        i = close + 1;
      } else if (c === "$" && src.startsWith("$(", i)) {
        // A substitution inside a word keeps the word opaque to its end.
        let depth = 1;
        i += 2;
        while (i < n && depth) {
          if (src[i] === "(") depth += 1;
          else if (src[i] === ")") depth -= 1;
          i += 1;
        }
        quoted = true;
      } else if (c === "\\" && i + 1 < n) {
        value += src[i + 1];
        i += 2;
      } else {
        value += c;
        i += 1;
      }
    }
    const word: Word = { value, start, end: Math.min(i, n), quoted };
    if (pendingHeredoc) {
      heredocs.push({ end: word.value, tabs: pendingHeredoc === "<<-" });
      pendingHeredoc = null;
    }
    out.push({ kind: "word", word });
  }
  return out;
}

/**
 * Each simple command as its argument words: leading assignments, redirect
 * targets, and reserved words removed.
 */
function simpleCommands(tokens: Lexeme[]): Word[][] {
  const commands: Word[][] = [];
  let words: Word[] = [];
  let prefixDone = false;
  let skipNext = false;
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k] as Lexeme;
    const next = tokens[k + 1];
    if (
      token.kind === "word" &&
      /^\d+$/.test(token.word.value) &&
      !token.word.quoted &&
      next?.kind === "op" &&
      REDIRECTS.includes(next.op) &&
      next.start === token.word.end
    ) {
      continue; // the 2 in 2>&1 is a file descriptor, not an argument
    }
    if (token.kind === "op") {
      if (SEPARATORS.has(token.op)) {
        if (words.length) commands.push(words);
        words = [];
        prefixDone = false;
        skipNext = false;
      } else {
        skipNext = true;
      }
      continue;
    }
    const word = token.word;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!words.length && !word.quoted) {
      if (RESERVED.has(word.value)) continue;
      if (!prefixDone && ASSIGNMENT.test(word.value)) continue;
    }
    prefixDone = true;
    words.push(word);
  }
  if (words.length) commands.push(words);
  return commands;
}

/** Arguments that are not flags or flag values. */
function positional(args: string[], valueFlags: Set<string> = new Set()): string[] {
  const out: string[] = [];
  let skip = false;
  for (const arg of args) {
    if (skip) {
      skip = false;
      continue;
    }
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (valueFlags.has(arg)) skip = true;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function intersects(args: string[], set: Set<string>): boolean {
  return args.some((arg) => set.has(arg));
}

function tscHeavy(args: string[]): boolean {
  return !intersects(args, TSC_INFO_FLAGS) && !intersects(args, WATCH_FLAGS);
}

function scriptHeavy(script: string, rest: string[]): boolean {
  if (intersects(rest, WATCH_FLAGS)) return false;
  if (HEAVY_SCRIPTS.test(script)) return true;
  return TEST_SCRIPTS.test(script) && positional(rest).length === 0;
}

/** A package binary launched by npx/bunx/yarn/pnpm exec/node_modules/.bin. */
function runBin(name: string, args: string[]): boolean {
  if (name === "tsc" || name === "typescript" || name.startsWith("typescript@")) {
    return tscHeavy(args);
  }
  if (name === "next" || name.startsWith("next@")) {
    return args[0] === "build" && !args.includes("-h") && !args.includes("--help");
  }
  return false;
}

/** Skip npx/bunx options to the binary name, then judge it. */
function runnerBin(args: string[], valueFlags: Set<string>): boolean {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    i += valueFlags.has(args[i] as string) ? 2 : 1;
  }
  return i < args.length && runBin(args[i] as string, args.slice(i + 1));
}

function skipFlags(args: string[], valueFlags: Set<string>): number {
  let i = 0;
  while (i < args.length && (args[i] as string).startsWith("-")) {
    i += valueFlags.has(args[i] as string) ? 2 : 1;
  }
  return i;
}

/** True when this simple command is a heavy check. */
function isHeavy(words: Word[], depth = 0): boolean {
  let args = words.map((word) => word.value);
  // Wrappers that are binaries (timeout, nice, nohup, env, stdbuf) or keywords.
  while (args.length) {
    const cmd = baseName(args[0] as string);
    if (cmd === "timeout") {
      let j = 1;
      while (j < args.length && (args[j] as string).startsWith("-")) {
        j += ["-k", "--kill-after", "-s", "--signal"].includes(args[j] as string) ? 2 : 1;
      }
      args = args.slice(j + 1);
    } else if (cmd === "nice") {
      if (args[1] === "-n") args = args.slice(3);
      else if (args[1] !== undefined && /^-\d+$/.test(args[1])) args = args.slice(2);
      else args = args.slice(1);
    } else if (["nohup", "time", "command", "exec", "stdbuf", "env"].includes(cmd)) {
      if (cmd === "command" && (args[1] === "-v" || args[1] === "-V")) return false;
      let j = 1;
      while (
        j < args.length &&
        ((args[j] as string).startsWith("-") ||
          (cmd === "env" && ASSIGNMENT.test(args[j] as string)))
      ) {
        j += 1;
      }
      args = args.slice(j);
    } else {
      break;
    }
  }
  if (!args.length) return false;
  const cmd = baseName(args[0] as string);
  const rest = args.slice(1);
  if (SHELLS.has(cmd) && depth < 2) {
    for (let k = 0; k < rest.length; k++) {
      if (SHELL_C_FLAG.test(rest[k] as string) && k + 1 < rest.length) {
        return simpleCommands(lex(rest[k + 1] as string)).some((inner) =>
          isHeavy(inner, depth + 1),
        );
      }
    }
    return false;
  }
  if (cmd === "tsc") return tscHeavy(rest);
  if (cmd === "next") return runBin("next", rest);
  if (cmd === "node") {
    const script = rest.find((arg) => !arg.startsWith("-")) ?? "";
    const after = rest.slice(rest.indexOf(script) + 1);
    if (script.endsWith("/tsc") || script.endsWith("typescript/bin/tsc")) return tscHeavy(after);
    if (script.endsWith("/next") || script.endsWith("next/dist/bin/next")) {
      return runBin("next", after);
    }
    return false;
  }
  if (cmd === "npx" || cmd === "bunx" || cmd === "pnpx") return runnerBin(rest, RUNNER_VALUE_FLAGS);
  if (cmd === "bun") {
    const i = skipFlags(rest, BUN_RUN_VALUE_FLAGS);
    if (i >= rest.length) return false;
    const sub = rest[i] as string;
    const tail = rest.slice(i + 1);
    if (sub === "x") return runnerBin(tail, new Set(["-p", "--package"]));
    if (sub === "test") {
      return !intersects(tail, WATCH_FLAGS) && positional(tail, BUN_TEST_VALUE_FLAGS).length === 0;
    }
    if (sub === "run") {
      const j = skipFlags(tail, BUN_RUN_VALUE_FLAGS);
      if (j >= tail.length) return false;
      const script = tail[j] as string;
      return scriptHeavy(script, tail.slice(j + 1)) || runBin(script, tail.slice(j + 1));
    }
    if (BUN_BUILTINS.has(sub) || sub.includes("/") || /\.(ts|js|tsx|mjs|cjs)$/.test(sub)) {
      return false;
    }
    return scriptHeavy(sub, tail) || runBin(sub, tail);
  }
  if (cmd === "npm" || cmd === "pnpm" || cmd === "yarn") {
    const i = skipFlags(rest, NPM_VALUE_FLAGS);
    if (i >= rest.length) return false;
    const sub = rest[i] as string;
    const tail = rest.slice(i + 1);
    if (sub === "test" || sub === "t" || sub === "tst") return scriptHeavy("test", tail);
    if (["run", "run-script", "rum", "urn"].includes(sub)) {
      const j = skipFlags(tail, NPM_VALUE_FLAGS);
      return j < tail.length && scriptHeavy(tail[j] as string, tail.slice(j + 1));
    }
    if (sub === "exec" || sub === "dlx") return runnerBin(tail, RUNNER_VALUE_FLAGS);
    // pnpm <script> and yarn <script|bin> run package scripts and bins directly.
    if (cmd !== "npm") return scriptHeavy(sub, tail) || runBin(sub, tail);
    return false;
  }
  return false;
}

/**
 * Offset to insert the wrapper: before binary wrappers, after the shell
 * keywords and builtins that `admission run` could not exec.
 */
function insertionPoint(words: Word[]): number {
  for (let k = 0; k < words.length; k++) {
    const word = words[k] as Word;
    const keyword =
      !word.quoted &&
      (word.value === "time" ||
        word.value === "command" ||
        word.value === "exec" ||
        (word.value === "-p" && k > 0 && words[k - 1]?.value === "time"));
    if (!keyword) return word.start;
  }
  return (words[0] as Word).start;
}

/** POSIX single-quote a word when it needs quoting (shlex.quote semantics). */
export function shellQuote(value: string): string {
  if (value === "") return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** True when a simple command already queues through admission on purpose. */
function alreadyAdmitted(words: Word[]): boolean {
  const first = baseName(words[0]?.value ?? "");
  if (first === "heavy-slot") return true;
  const values = words.map((word) => word.value);
  const at = values.indexOf("admission");
  return at !== -1 && values[at + 1] === "run";
}

/**
 * Return the command with each heavy simple command wrapped in `wrapper`
 * (a shell-ready prefix such as `harn admission run --resource build`), or
 * null when nothing changes.
 */
export function rewriteHeavyCommand(command: string, wrapper: string): string | null {
  if (command.includes(ADMISSION_SKIP_PREFIX)) return null;
  const commands = simpleCommands(lex(command));
  if (commands.some(alreadyAdmitted)) return null;
  const inserts: { at: number; text: string }[] = [];
  for (const words of commands) {
    if (!isHeavy(words)) continue;
    const at = insertionPoint(words);
    let label = command
      .slice((words[0] as Word).start, (words.at(-1) as Word).end)
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    if (label.length > LABEL_MAX) label = `${label.slice(0, LABEL_MAX - 1)}~`;
    inserts.push({ at, text: `${wrapper} --label ${shellQuote(`agent: ${label}`)} -- ` });
  }
  if (!inserts.length) return null;
  let out = command;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) {
    out = out.slice(0, at) + text + out.slice(at);
  }
  return out;
}

const SHELL_TOOLS = new Set(["bash", "shell", "shell_command", "exec_command", "local_shell"]);

/** Normalized shell-tool name, or null for any other tool. */
export function shellToolName(toolName: unknown): string | null {
  if (typeof toolName !== "string") return null;
  const name = toolName.toLowerCase().replace(/^functions\./, "");
  return SHELL_TOOLS.has(name) ? name : null;
}

export interface AdmissionRewrite {
  updatedInput: Record<string, unknown>;
}

/**
 * Rewrite a shell tool's input so its heavy checks queue for admission.
 * Handles `command` or `cmd` as a string, or as an argv such as
 * ["bash", "-lc", "<script>"]. Returns null when nothing changes.
 */
export function admissionRewriteForTool(
  toolName: unknown,
  toolInput: unknown,
  wrapper: string,
): AdmissionRewrite | null {
  if (shellToolName(toolName) === null) return null;
  let input = toolInput;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd"]) {
    const value = record[key];
    if (typeof value === "string") {
      const next = rewriteHeavyCommand(value, wrapper);
      return next === null ? null : { updatedInput: { ...record, [key]: next } };
    }
    if (Array.isArray(value) && value.length && value.every((v) => typeof v === "string")) {
      const argv = value as string[];
      if (
        argv.length >= 3 &&
        SHELLS.has(baseName(argv[0] as string)) &&
        SHELL_C_FLAG.test(argv[argv.length - 2] as string)
      ) {
        const next = rewriteHeavyCommand(argv[argv.length - 1] as string, wrapper);
        return next === null
          ? null
          : { updatedInput: { ...record, [key]: [...argv.slice(0, -1), next] } };
      }
      const next = rewriteHeavyCommand(argv.map(shellQuote).join(" "), wrapper);
      return next === null ? null : { updatedInput: { ...record, [key]: ["bash", "-c", next] } };
    }
  }
  return null;
}

export interface AdmissionHookInput {
  adapter: string;
  /** Admission resource the project's guard queues on. */
  resource: string;
  /** Host bin name used in the wrapper and the agent-facing note. */
  bin: string;
  /**
   * Project whose admission config `admission run` should read. A nested
   * checkout with its own `.harnery/` would otherwise shadow the host's
   * resource settings for a shell started inside it.
   */
  projectRoot?: string;
  toolName: unknown;
  toolInput: unknown;
  cwd?: unknown;
  /** True when HARNERY_ADMISSION_SKIP=1 or HARNERY_ADMISSION_HELD is set for the hook. */
  skip?: boolean;
  platform?: string;
}

/**
 * The PreToolUse output that queues a shell command's heavy checks, or null
 * to let the command run as written. Claude Code applies `updatedInput`
 * under the session's own permission rules, so no decision is sent, and its
 * Bash timeout is raised to the maximum because a queued wait counts against
 * it. Codex applies a rewrite only beside `permissionDecision: "allow"`.
 * Cursor and OpenCode have no rewrite channel. Windows-native shells (a
 * drive-letter or UNC workspace) are outside the machine whose queue this
 * guards.
 */
export function admissionHookOutput(input: AdmissionHookInput): Record<string, unknown> | null {
  if (input.skip) return null;
  if (input.adapter !== "claude-code" && input.adapter !== "codex") return null;
  const cwd = typeof input.cwd === "string" ? input.cwd : "";
  if (input.platform === "win32" || /^(?:\\\\|[A-Za-z]:[\\/])/.test(cwd)) return null;
  const wrapper =
    `${shellQuote(input.bin)} admission run --resource ${shellQuote(input.resource)}` +
    (input.projectRoot ? ` --project-root ${shellQuote(input.projectRoot)}` : "");
  const rewrite = admissionRewriteForTool(input.toolName, input.toolInput, wrapper);
  if (!rewrite) return null;
  const updatedInput = rewrite.updatedInput;
  const output: Record<string, unknown> = { hookEventName: "PreToolUse", updatedInput };
  if (input.adapter === "codex") {
    output.permissionDecision = "allow";
  } else {
    if (shellToolName(input.toolName) === "bash" && !updatedInput.run_in_background) {
      const current = updatedInput.timeout;
      if (typeof current !== "number" || current < BASH_TIMEOUT_MAX_MS) {
        updatedInput.timeout = BASH_TIMEOUT_MAX_MS;
      }
    }
    output.additionalContext =
      `Harnery queued this command's heavy check for a machine-wide \`${input.resource}\` ` +
      `admission slot, so it may wait first; \`${input.bin} admission status --resource ` +
      `${input.resource}\` shows the queue. Prefix ${ADMISSION_SKIP_PREFIX} to run a check ` +
      `ungated on purpose.`;
  }
  return { hookSpecificOutput: output };
}
