import { basename, shellCommandFromTool, tokenize } from "./shell-tokens.ts";

/**
 * Deny `git commit-tree` in an agent's shell command. In a checkout shared by
 * several agents, a peer's commit can hold the Git index lock for minutes
 * while its pre-commit checks run. An agent that builds its own commit from a
 * separate index with `git commit-tree` and pushes it gets around that lock,
 * and with it every pre-commit check and the commit-time claim guard. The
 * right move is to wait for the peer's commit to finish.
 *
 * A guardrail against the reflex, not a security boundary: it reads command
 * positions only (so quoted examples and other tools pass), skips Git's
 * global options, and looks inside `bash -c '...'`.
 * HARNERY_ALLOW_COMMIT_TREE=1 on the command is the deliberate override.
 */

const OVERRIDE = "HARNERY_ALLOW_COMMIT_TREE=1";
const SEPARATORS = new Set([";", "|", "||", "&", "&&", "(", ")", "{", "}"]);
const KEYWORDS = new Set(["do", "if", "then", "elif", "else", "!", "while", "until", "time"]);
const WRAPPERS = new Set(["command", "exec", "builtin", "nohup", "sudo", "doas", "env", "nice"]);
// Git global options that consume the following token as their value.
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);

function gitSubcommand(args: { value: string; operator?: boolean }[]): string | null {
  for (let j = 0; j < args.length; j++) {
    const arg = args[j]!;
    if (arg.operator) return null;
    if (arg.value.startsWith("-")) {
      if (GIT_VALUE_OPTIONS.has(arg.value)) j++;
      continue;
    }
    return arg.value;
  }
  return null;
}

function invokesCommitTree(source: string, depth = 0): boolean {
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
    if (token.quoted) continue;
    if (name === "git" && gitSubcommand(tokens.slice(i + 1)) === "commit-tree") return true;
    if (name === "git-commit-tree") return true;
    if (["bash", "sh", "dash", "zsh", "ksh"].includes(name)) {
      for (let j = i + 1; j < tokens.length && !tokens[j]!.operator; j++) {
        if (/^-[a-z]*c[a-z]*$/.test(tokens[j]!.value)) {
          const script = tokens[j + 1];
          if (script && !script.operator && invokesCommitTree(script.value, depth + 1)) return true;
          break;
        }
      }
    }
  }
  return false;
}

export function shellCommitTreeReason(
  toolName: unknown,
  toolInput: unknown,
  binName: string,
): string | null {
  const command = shellCommandFromTool(toolName, toolInput);
  if (command === null || !invokesCommitTree(command)) return null;
  return (
    `git commit-tree blocked: building a commit by hand gets around the Git index lock, and with ` +
    `it every pre-commit check and the claim guard. When a peer's commit holds the lock, wait ` +
    `for it to finish (\`${binName} admission status\` shows whether its checks are queued for a ` +
    `slot), then commit normally. If you genuinely need plumbing, prefix the command with ` +
    `${OVERRIDE}.`
  );
}
