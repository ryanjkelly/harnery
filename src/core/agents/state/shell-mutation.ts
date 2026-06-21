/**
 * A heuristic parser that extracts file paths likely to be mutated by a
 * shell command. Used by
 * the cursor + codex harness adapters to emit SHELL_CLAIM_CANDIDATE log lines
 * (warn-only, never blocks).
 *
 * Two cases:
 *   1. Output redirections: `> path` and `>> path`
 *   2. Common mutators: `sed -i…`, `cp`, `mv`, `touch`: capture the next
 *      non-space token after the command name (intentionally single-arg even
 *      though `cp src dest` has two args)
 *
 * Caller-supplied `coordRoot` is stripped from absolute paths so the warn
 * log shows monorepo-relative form.
 */

export function shellMutationPaths(cmd: string, coordRoot: string | null = null): string[] {
  if (!cmd) return [];
  const out: string[] = [];

  // Output redirections: > path / >> path
  const redirectRe = />>?[ \t]+([^ \t;|&"'`]+)/g;
  let m: RegExpExecArray | null = redirectRe.exec(cmd);
  while (m !== null) {
    out.push(m[1]!);
    m = redirectRe.exec(cmd);
  }

  // Common mutators. Capture up to the first whitespace after the command
  // name and take the final token. For 1-arg commands (touch, sed -i 'expr',
  // cp WITHOUT a dest) that's the path; for 2-arg commands (`cp src dest`,
  // `mv src dest`) it's the source, intentionally heuristic-only.
  const cmdRe = /\b(?:sed -i\S*|cp|mv|touch)[ \t]+([^ \t;|&]+)/g;
  m = cmdRe.exec(cmd);
  while (m !== null) {
    out.push(m[1]!);
    m = cmdRe.exec(cmd);
  }

  return out
    .map((p) => p.replace(/^\.\//, ""))
    .map((p) => (coordRoot && p.startsWith(`${coordRoot}/`) ? p.slice(coordRoot.length + 1) : p))
    .filter((p) => p.length > 0);
}
