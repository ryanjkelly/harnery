/** Recognize inline waiters; this is not a proof of arbitrary shell termination. */
const REASON =
  "Inline shell waiter blocked: polling loops and delayed log-only checks can outlive the job " +
  "and accumulate as background tasks. Read the existing task output now, or wait on its " +
  "existing task handle. If polling is necessary, use a reviewed script with a hard deadline, " +
  "nonzero timeout exit, and producer-exit/failure detection. Do not create another waiter " +
  "to check progress or infer completion from a broad pgrep -f pattern.";

interface Token {
  value: string;
  quoted: boolean;
  operator?: boolean;
}

/** Keep quoted arguments opaque, including examples and heredoc bodies. */
function tokenize(source: string): Token[] {
  const out: Token[] = [];
  const heredocs: { end: string; tabs: boolean }[] = [];
  for (let i = 0; i < source.length; ) {
    const ch = source[i]!;
    if (ch === "\\" && source[i + 1] === "\n") {
      i += 2;
      continue;
    }
    if (ch === "\n") {
      out.push({ value: ";", quoted: false, operator: true });
      i++;
      for (const doc of heredocs.splice(0)) {
        while (i < source.length) {
          const end = source.indexOf("\n", i);
          const stop = end === -1 ? source.length : end;
          const line = source.slice(i, stop);
          i = end === -1 ? source.length : end + 1;
          if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.end) break;
        }
      }
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "#") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (";|&(){}<>".includes(ch)) {
      const op = source.slice(i).match(/^(?:<<-?|>>|&&|\|\||[;|&(){}<>])/)![0];
      out.push({ value: op, quoted: false, operator: true });
      i += op.length;
      continue;
    }
    let value = "";
    let quoted = false;
    while (i < source.length && !/[\s;|&(){}<>]/.test(source[i]!)) {
      const next = source[i++]!;
      if (next === "'" || next === '"' || next === "`") {
        quoted = true;
        while (i < source.length && source[i] !== next) {
          if (source[i] === "\\" && next !== "'" && i + 1 < source.length) i++;
          value += source[i++]!;
        }
        if (source[i] === next) i++;
      } else if (next === "\\" && i < source.length) {
        const escaped = source[i++]!;
        if (escaped !== "\n") value += escaped;
      } else {
        value += next;
      }
    }
    const previous = out.at(-1)?.value;
    if (previous === "<<" || previous === "<<-") {
      heredocs.push({ end: value, tabs: previous === "<<-" });
    }
    out.push({ value, quoted });
  }
  return out;
}

function basename(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? value;
}

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
  const readers = new Set(["tail", "cat", "head", "grep", "rg", "sed", "wc"]);
  const harmless = new Set(["sleep", "cd", "pwd", "echo", "printf", "date", ...readers]);
  return (
    sleep !== -1 &&
    commands.slice(sleep + 1).some((name) => readers.has(name)) &&
    commands.every((name) => harmless.has(name))
  );
}

export function shellWaiterReason(toolName: unknown, toolInput: unknown): string | null {
  if (typeof toolName !== "string") return null;
  const name = toolName.toLowerCase().replace(/^functions\./, "");
  if (!["bash", "shell", "shell_command", "exec_command"].includes(name)) return null;
  let input = toolInput;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return null;
    }
  }
  if (!input || typeof input !== "object") return null;
  const args = input as Record<string, unknown>;
  const command = args.command ?? args.cmd;
  return typeof command === "string" && isWaiter(command) ? REASON : null;
}
