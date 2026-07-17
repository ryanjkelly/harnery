/**
 * Git plumbing for the cross-machine presence transport (ADR 0016).
 *
 * Presence blobs travel as parentless commits (empty tree, JSON message)
 * force-pushed to `refs/harnery/presence/<machine>` on the host repo's own
 * `origin`. Non-branch refs: invisible to branch tooling, safe to force-push,
 * no history accumulation. The remote is the rendezvous every install already
 * shares, and repo access is the ACL.
 *
 * Everything here is best-effort and fail-silent by design — presence must
 * never break a hook or a render. Network operations (push/fetch) run either
 * detached (hook path: never block a turn) or synchronously (CLI path: the
 * user wants to see errors).
 */

import { spawn, spawnSync } from "node:child_process";

/** The ref namespace. Hardcoded — never interpolated from config — so the
 * publisher is structurally unable to touch refs/heads/* (ADR 0016). */
export const PRESENCE_REF_PREFIX = "refs/harnery/presence/";

/** Well-known SHA of git's empty tree; `git mktree` below guarantees the
 * object exists in the local odb before we build a commit on it. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const GIT_TIMEOUT_MS = 8000;

/** Non-interactive env for every presence git call: never prompt for creds
 * (a hook must not hang on a password), and a fixed identity so commit-tree
 * works on machines with no user.name/user.email configured. */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "harnery-presence",
    GIT_AUTHOR_EMAIL: "presence@harnery.invalid",
    GIT_COMMITTER_NAME: "harnery-presence",
    GIT_COMMITTER_EMAIL: "presence@harnery.invalid",
  };
}

function runGit(
  root: string,
  args: string[],
  input?: string,
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const r = spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      env: gitEnv(),
      ...(input !== undefined ? { input } : {}),
    });
    return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch {
    return { ok: false, stdout: "", stderr: "spawn failed" };
  }
}

/** Does the repo have an `origin` remote to rendezvous on? */
export function hasOrigin(root: string): boolean {
  return runGit(root, ["remote", "get-url", "origin"]).ok;
}

/**
 * Sanitize a machine label into a valid single ref component: lowercase,
 * [a-z0-9._-] only, no leading dot, no `.lock` suffix, never empty.
 */
export function sanitizeRefComponent(label: string): string {
  let s = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+/, "")
    .replace(/\.lock$/, "");
  if (!s) s = "unknown";
  return s;
}

/** Build the parentless presence commit carrying `message` (the JSON blob).
 * Returns the commit sha, or null on failure. Local-only, fast (~10ms). */
export function writePresenceCommit(root: string, message: string): string | null {
  // Ensure the empty-tree object exists in this odb (mktree with empty stdin
  // writes it idempotently).
  const mk = runGit(root, ["mktree"], "");
  const tree = mk.ok && mk.stdout.trim() ? mk.stdout.trim() : EMPTY_TREE_SHA;
  const r = runGit(root, ["commit-tree", tree, "-m", message]);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * Force-push a presence commit to `refs/harnery/presence/<machine>`.
 * `sync: true` (CLI/tests) waits and reports; default is detached fire-and-
 * forget (hook path — a slow or credential-less push must not block a turn).
 */
export function pushPresenceRef(
  root: string,
  machine: string,
  sha: string,
  opts: { sync?: boolean } = {},
): { ok: boolean; error?: string } {
  const refspec = `+${sha}:${PRESENCE_REF_PREFIX}${sanitizeRefComponent(machine)}`;
  const args = ["-C", root, "push", "--quiet", "--no-verify", "origin", refspec];
  if (opts.sync) {
    const r = runGit(root, args.slice(2));
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim().slice(0, 300) };
  }
  try {
    const child = spawn("git", args, { detached: true, stdio: "ignore", env: gitEnv() });
    child.unref();
    return { ok: true };
  } catch {
    return { ok: false, error: "spawn failed" };
  }
}

/** Fetch every peer presence ref from origin into the local ref namespace. */
export function fetchPresenceRefs(
  root: string,
  opts: { sync?: boolean } = {},
): { ok: boolean; error?: string } {
  const refspec = `+${PRESENCE_REF_PREFIX}*:${PRESENCE_REF_PREFIX}*`;
  const args = ["-C", root, "fetch", "--quiet", "--no-tags", "origin", refspec];
  if (opts.sync) {
    const r = runGit(root, args.slice(2));
    return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim().slice(0, 300) };
  }
  try {
    const child = spawn("git", args, { detached: true, stdio: "ignore", env: gitEnv() });
    child.unref();
    return { ok: true };
  } catch {
    return { ok: false, error: "spawn failed" };
  }
}

/** Read every locally-known presence ref → [{ref, machine, message}]. */
export function readPresenceRefs(root: string): Array<{ machine: string; message: string }> {
  const r = runGit(root, [
    "for-each-ref",
    "--format=%(refname)%00%(contents)%01",
    `${PRESENCE_REF_PREFIX}*`,
  ]);
  if (!r.ok) return [];
  return parseForEachRefOutput(r.stdout);
}

/**
 * Parse `for-each-ref --format='%(refname)%00%(contents)%01'` output.
 * Records are %01-terminated (contents may contain newlines); refname and
 * contents are %00-separated. Exported for unit tests.
 */
export function parseForEachRefOutput(out: string): Array<{ machine: string; message: string }> {
  const rows: Array<{ machine: string; message: string }> = [];
  for (const rec of out.split("\u0001")) {
    const trimmed = rec.replace(/^\n+/, "");
    if (!trimmed) continue;
    const sep = trimmed.indexOf("\u0000");
    if (sep === -1) continue;
    const refname = trimmed.slice(0, sep).trim();
    if (!refname.startsWith(PRESENCE_REF_PREFIX)) continue;
    rows.push({
      machine: refname.slice(PRESENCE_REF_PREFIX.length),
      message: trimmed.slice(sep + 1).trim(),
    });
  }
  return rows;
}
