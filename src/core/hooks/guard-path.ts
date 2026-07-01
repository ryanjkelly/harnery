/**
 * Canonicalize a write-tool target path for the claim guard.
 *
 * Returns the monorepo-relative path, or `null` when the target lies OUTSIDE the
 * repo (an absolute path not under coordRoot, e.g. a `/tmp` scratchpad or other
 * session-temp file).
 *
 * Out-of-repo files are session-private, never shared coordinated resources, so
 * the claim guard must skip them. Claiming them is doubly wrong. First, it
 * pollutes a heartbeat's `files_touched` with non-repo paths. Second, the
 * ordering rule compares raw path strings, and an absolute `/tmp/…` sorts before
 * every repo-relative path (`/` = 0x2F < any letter), so a scratchpad write
 * would spuriously "block" a legitimately-held repo file. Returning null keeps
 * such paths out of the claim system entirely.
 *
 * Relative inputs are assumed already-repo-relative (Codex `apply_patch` emits
 * cwd-relative paths). The in-repo check requires the `<root>/` separator, so a
 * sibling dir that merely shares a prefix (`/repo-other` vs `/repo`) is treated
 * as out-of-repo, not stripped.
 */
export function canonicalize(coordRoot: string, p: string): string | null {
  if (!p) return null;
  if (p === coordRoot) return ".";
  if (p.startsWith(`${coordRoot}/`)) return p.slice(coordRoot.length + 1);
  if (p.startsWith("/")) return null; // absolute + not under coordRoot → out-of-repo
  return p; // relative → treat as repo-relative
}
