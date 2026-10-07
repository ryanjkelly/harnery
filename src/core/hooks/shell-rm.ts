import { basename, shellCommandFromTool, tokenize } from "./shell-tokens.ts";

/**
 * Deny a shell `rm` and name the guarded replacement. The instructions have
 * said "use <bin> rm instead of shell rm" since the command shipped, and
 * agents still reached for bare rm several times a day, often on unquoted
 * variable paths that Claude Code then stops on for a human prompt. A
 * repeated, machine-detectable failure belongs in a gate, not more prose.
 *
 * This is a guardrail against the reflex, not a security boundary: it reads
 * command positions only (so `git rm`, `docker rm`, and quoted examples pass),
 * plus the `xargs rm`, `find -exec rm`, and `bash -c '...rm...'` shapes.
 * HARNERY_ALLOW_RM=1 on the command is the deliberate override.
 */

const OVERRIDE = "HARNERY_ALLOW_RM=1";
const SEPARATORS = new Set([";", "|", "||", "&", "&&", "(", ")", "{", "}"]);
const KEYWORDS = new Set(["do", "if", "then", "elif", "else", "!", "while", "until", "time"]);
const WRAPPERS = new Set(["command", "exec", "builtin", "nohup", "sudo", "doas", "env", "nice"]);
// xargs options that consume the following token as their value.
const XARGS_VALUE_FLAGS = new Set(["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a"]);

function isRm(value: string, quoted: boolean): boolean {
  return !quoted && basename(value) === "rm";
}

function invokesRm(source: string, depth = 0): boolean {
  if (depth > 8) return false;
  const tokens = tokenize(source);
  if (tokens.some((t) => !t.quoted && t.value === OVERRIDE)) return false;
  let start = true;
  let afterWrapper = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.operator) {
      if (SEPARATORS.has(token.value)) {
        start = true;
        afterWrapper = false;
      }
      continue;
    }
    if (!start) continue;
    if (!token.quoted) {
      if (KEYWORDS.has(token.value)) continue;
      if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(token.value)) continue;
      if (afterWrapper && token.value.startsWith("-")) continue;
    }
    const name = basename(token.value);
    if (WRAPPERS.has(name)) {
      afterWrapper = true;
      continue;
    }
    start = false;
    afterWrapper = false;
    if (isRm(token.value, token.quoted)) return true;
    if (name === "xargs") {
      for (let j = i + 1; j < tokens.length && !tokens[j]!.operator; j++) {
        const arg = tokens[j]!;
        if (arg.value.startsWith("-")) {
          if (XARGS_VALUE_FLAGS.has(arg.value)) j++;
          continue;
        }
        if (isRm(arg.value, arg.quoted)) return true;
        break;
      }
    }
    if (name === "find") {
      for (let j = i + 1; j < tokens.length && !tokens[j]!.operator; j++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(tokens[j]!.value)) continue;
        const next = tokens[j + 1];
        if (next && !next.operator && isRm(next.value, next.quoted)) return true;
      }
    }
    if (["bash", "sh", "dash", "zsh", "ksh"].includes(name)) {
      for (let j = i + 1; j < tokens.length && !tokens[j]!.operator; j++) {
        if (/^-[a-z]*c[a-z]*$/.test(tokens[j]!.value)) {
          const script = tokens[j + 1];
          if (script && !script.operator && invokesRm(script.value, depth + 1)) return true;
          break;
        }
      }
    }
  }
  return false;
}

export function shellRmReason(
  toolName: unknown,
  toolInput: unknown,
  binName: string,
): string | null {
  const command = shellCommandFromTool(toolName, toolInput);
  if (command === null || !invokesRm(command)) return null;
  return (
    `Shell rm blocked: it skips the resolved-path, Git-ownership, and peer-claim checks, and an ` +
    `unquoted variable path can expand to the wrong target. Use the guarded paths instead: ` +
    `\`${binName} rm --root <directory> <paths...>\` previews removal of untracked files (add ` +
    `--yes to delete, -r for a directory); \`git rm\` removes tracked source; ` +
    `\`${binName} artifacts discard <id>\` retires managed evidence. To replace a file, overwrite ` +
    `it in place or \`mv\` the new file over the old one, so nothing needs deleting. If none of ` +
    `these fit, prefix the command with ${OVERRIDE}.`
  );
}
