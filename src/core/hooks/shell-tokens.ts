/** Shared, deliberately small shell lexer for PreToolUse command guards. */

export interface Token {
  value: string;
  quoted: boolean;
  operator?: boolean;
}

/** Keep quoted arguments opaque, including examples and heredoc bodies. */
export function tokenize(source: string): Token[] {
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

export function basename(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? value;
}

/** The command string of a Bash-style tool call, or null for any other tool. */
export function shellCommandFromTool(toolName: unknown, toolInput: unknown): string | null {
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
  return typeof command === "string" ? command : null;
}
