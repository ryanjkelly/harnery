import { basename, shellCommandFromTool, tokenize } from "./shell-tokens.ts";

/** Recognize inline waiters; this is not a proof of arbitrary shell termination. */
const REASON =
  "Inline shell waiter blocked: polling loops and delayed log-only checks can outlive the job " +
  "and accumulate as background tasks. Read the existing task output now, or wait on its " +
  "existing task handle. If polling is necessary, use a reviewed script with a hard deadline, " +
  "nonzero timeout exit, and producer-exit/failure detection. Do not create another waiter " +
  "to check progress or infer completion from a broad pgrep -f pattern.";

function isWaiter(source: string, depth = 0): boolean {
  if (depth > 8) return false;
  const tokens = tokenize(source);
  let loops = 0;
  const commands: string[] = [];
  let start = true;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.operator) {
      if ([";", "|", "||", "&", "&&", "(", ")", "{", "}"].includes(token.value)) start = true;
      continue;
    }
    if (!start) continue;
    if (!token.quoted) {
      if (["while", "until", "for", "select"].includes(token.value)) {
        loops++;
        continue;
      }
      if (token.value === "done") {
        loops = Math.max(0, loops - 1);
        continue;
      }
      if (["do", "if", "then", "elif", "else", "!"].includes(token.value)) continue;
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(token.value)) continue;
    }
    const name = basename(token.value);
    if (name === "timeout") {
      // Skip timeout options and its duration; inspect the wrapped executable.
      let j = i + 1;
      for (; j < tokens.length && !tokens[j]!.operator; j++) {
        if (/^(?:\d+(?:\.\d*)?|\.\d+)[smhd]?$/.test(tokens[j]!.value)) {
          // -k/--kill-after takes its own duration before the main duration.
          const previous = tokens[j - 1]?.value;
          if (previous === "-k" || previous === "--kill-after") continue;
          i = j;
          break;
        }
      }
      if (i === j) continue;
    }
    if (["command", "exec", "builtin", "nohup"].includes(name)) continue;
    start = false;
    commands.push(name);
    if (loops && ["sleep", "pgrep"].includes(name)) return true;
    if (["bash", "sh", "dash", "zsh", "ksh"].includes(name)) {
      for (let j = i + 1; j < tokens.length && !tokens[j]!.operator; j++) {
        if (/^-[a-z]*c[a-z]*$/.test(tokens[j]!.value)) {
          const script = tokens[j + 1];
          if (script && !script.operator && isWaiter(script.value, depth + 1)) return true;
          break;
        }
      }
    }
  }
  const sleep = commands.indexOf("sleep");
  // sed can edit files or execute commands; its name alone does not prove a log read.
  const readers = new Set(["tail", "cat", "head", "grep", "rg", "wc"]);
  const harmless = new Set(["sleep", "cd", "pwd", "echo", "printf", "date", ...readers]);
  return (
    sleep !== -1 &&
    commands.slice(sleep + 1).some((name) => readers.has(name)) &&
    commands.every((name) => harmless.has(name))
  );
}

export function shellWaiterReason(toolName: unknown, toolInput: unknown): string | null {
  const command = shellCommandFromTool(toolName, toolInput);
  return command !== null && isWaiter(command) ? REASON : null;
}
