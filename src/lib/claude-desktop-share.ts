import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type DesktopAccount, type DesktopSessionEntry, listAccounts } from "./claude-desktop.ts";

/**
 * Cross-machine Claude desktop session sharing through a synced folder.
 *
 * The desktop app's sidebar (see claude-desktop.ts) and the transcripts it
 * resumes from (`~/.claude/projects/<slug>/<cliSessionId>.jsonl`) are both
 * machine-local. A user with two computers therefore sees only the sessions
 * started on the one in front of them. `share` closes that gap through any
 * folder both machines sync (iCloud Drive, Dropbox, a network share):
 *
 *   <shareDir>/<machine>/manifest.json            { machine, home, exported_at }
 *   <shareDir>/<machine>/sessions/<cliId>/entry.json
 *   <shareDir>/<machine>/sessions/<cliId>/transcript.jsonl
 *   <shareDir>/<machine>/sessions/<cliId>/sidecar/   (optional per-session dir)
 *
 * Export publishes this machine's recent sessions under its own directory;
 * import reads every other machine's directory and makes each session
 * listed and resumable here. Each machine writes only its own directory, so
 * the synced folder never has two writers for one file.
 *
 * Transcripts are append-only, which gives a safe merge rule: a remote copy
 * replaces the local one only when the local file is missing or is a strict
 * byte prefix of the remote (the other machine continued the conversation).
 * A local transcript that is longer, diverged, or written in the last few
 * minutes (a live session here) is never overwritten.
 *
 * A synced folder can list a file before its bytes arrive (an iCloud
 * "dataless" placeholder). Reading one blocks until the download finishes, or
 * fails outright, so such sessions are skipped as "not-downloaded", a download
 * is requested, and the next pass picks them up. One session that still fails
 * to copy is reported under `failed` and never stops the rest of the pass.
 */

export interface ShareOptions {
  shareDir: string;
  machine: string;
  /** Only sessions active within this many days. */
  days: number;
  /** Desktop data dir (the one holding claude-code-sessions/). */
  dataDir: string;
  /** Account whose sidebar receives imported entries. */
  targetAccountUuid: string;
  /** Override for tests. */
  home?: string;
  /** Override for tests (ms since epoch). */
  now?: number;
  /** Local transcripts modified this recently count as live (ms). */
  liveWindowMs?: number;
  /** Override for tests: which of these paths are not downloaded yet. */
  findPlaceholders?: (paths: string[]) => Set<string>;
  /** Override for tests: ask the sync client to download these paths. */
  requestDownload?: (paths: string[]) => void;
}

export interface ExportAction {
  cliSessionId: string;
  title: string | null;
  transcript: string;
  bytes: number;
}

export type ImportKind = "new" | "updated" | "entry-only";

export interface ImportAction {
  kind: ImportKind;
  machine: string;
  cliSessionId: string;
  title: string | null;
  cwd: string;
  /** Remote transcript to copy, or null when only the entry changes. */
  transcriptFrom: string | null;
  transcriptTo: string;
  sidecarFrom: string | null;
  entryFrom: string;
  /** Local entry to patch (existing session) or create (new session). */
  entryTo: string;
  entryExists: boolean;
  remoteLastActivityAt: number | null;
}

export interface ImportSkip {
  machine: string;
  cliSessionId: string;
  title: string | null;
  reason:
    | "up-to-date"
    | "local-newer"
    | "diverged"
    | "live-here"
    | "missing-cwd"
    | "unreadable"
    | "not-downloaded";
}

export interface SharePlan {
  exports: ExportAction[];
  imports: ImportAction[];
  skips: ImportSkip[];
  machines: string[];
}

export interface ImportFailure {
  machine: string;
  cliSessionId: string;
  title: string | null;
  error: string;
}

/** macOS st_flags bit for a file whose contents live only in the cloud. */
const SF_DATALESS = 0x40000000;

/**
 * Paths whose bytes are not on this disk yet. On macOS this reads st_flags
 * (Node's stat does not expose them) in one `stat` call; everywhere else only
 * the `.<name>.icloud` stub convention applies.
 */
export function findPlaceholders(paths: string[]): Set<string> {
  const out = new Set<string>();
  const present: string[] = [];
  for (const p of paths) {
    if (existsSync(p)) present.push(p);
    else if (existsSync(join(dirname(p), `.${p.slice(dirname(p).length + 1)}.icloud`))) out.add(p);
  }
  if (process.platform !== "darwin" || present.length === 0) return out;
  const r = spawnSync("/usr/bin/stat", ["-f", "%Xf %N", ...present], { encoding: "utf8" });
  for (const line of (r.stdout ?? "").split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const flags = Number.parseInt(line.slice(0, sp), 16);
    if (Number.isFinite(flags) && (flags & SF_DATALESS) !== 0) out.add(line.slice(sp + 1));
  }
  return out;
}

/** Best-effort, fire-and-forget: ask iCloud Drive to fetch these paths. */
export function requestDownload(paths: string[]): void {
  if (process.platform !== "darwin") return;
  for (const p of paths) {
    try {
      spawn("/usr/bin/brctl", ["download", p], { stdio: "ignore", detached: true }).unref();
    } catch {
      // Not an iCloud folder or brctl missing; the next pass retries.
    }
  }
}

export function defaultShareDir(home = homedir()): string | null {
  if (process.platform !== "darwin") return null;
  const icloud = join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
  return existsSync(icloud) ? join(icloud, "Harnery", "claude-sessions") : null;
}

/** Claude Code's per-project transcript folder name for a working directory. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

function transcriptPath(home: string, cwd: string, cliSessionId: string): string {
  return join(home, ".claude", "projects", projectSlug(cwd), `${cliSessionId}.jsonl`);
}

function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function readJson(p: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Rewrite a path from the remote home to the local one (same layout, different user). */
export function remapHome(p: string, remoteHome: string | null, localHome: string): string {
  if (!remoteHome || remoteHome === localHome) return p;
  if (p === remoteHome) return localHome;
  return p.startsWith(`${remoteHome}/`) ? localHome + p.slice(remoteHome.length) : p;
}

/** True when `prefixFile`'s bytes are exactly the start of `fullFile`. */
export function isBytePrefix(prefixFile: string, fullFile: string): boolean {
  const a = safeStat(prefixFile);
  const b = safeStat(fullFile);
  if (!a || !b || a.size > b.size) return false;
  const chunk = 1 << 20;
  const fa = openSync(prefixFile, "r");
  const fb = openSync(fullFile, "r");
  try {
    const ba = Buffer.alloc(chunk);
    const bb = Buffer.alloc(chunk);
    let pos = 0;
    while (pos < a.size) {
      const n = Math.min(chunk, a.size - pos);
      readSync(fa, ba, 0, n, pos);
      readSync(fb, bb, 0, n, pos);
      if (ba.compare(bb, 0, n, 0, n) !== 0) return false;
      pos += n;
    }
    return true;
  } finally {
    closeSync(fa);
    closeSync(fb);
  }
}

/** Newest non-archived entry per cliSessionId across every local account. */
function localEntriesById(accounts: DesktopAccount[]): Map<string, DesktopSessionEntry> {
  const out = new Map<string, DesktopSessionEntry>();
  for (const a of accounts) {
    for (const e of a.entries) {
      if (!e.cliSessionId) continue;
      const prev = out.get(e.cliSessionId);
      if (!prev || (e.lastActivityAt ?? 0) > (prev.lastActivityAt ?? 0)) out.set(e.cliSessionId, e);
    }
  }
  return out;
}

/**
 * Env directory new entries go into: the one holding the account's newest
 * entry, else any env directory the app already created for the account.
 */
function targetEnvDir(account: DesktopAccount | undefined): string | null {
  if (!account) return null;
  const newest = account.entries[0];
  if (newest) return join(account.path, newest.envId);
  const env = safeReaddir(account.path).find((d) => safeStat(join(account.path, d))?.isDirectory());
  return env ? join(account.path, env) : null;
}

export function planShare(opts: ShareOptions): SharePlan {
  const home = opts.home ?? homedir();
  const now = opts.now ?? Date.now();
  const liveWindow = opts.liveWindowMs ?? 3 * 60_000;
  const cutoff = now - opts.days * 86_400_000;
  const accounts = listAccounts(opts.dataDir);
  const local = localEntriesById(accounts);

  // Export: this machine's recent sessions whose transcript exists here and
  // differs from what was last published.
  const exports: ExportAction[] = [];
  const mine = join(opts.shareDir, opts.machine, "sessions");
  for (const e of local.values()) {
    if (e.isArchived || !e.cwd || !e.cliSessionId) continue;
    if ((e.lastActivityAt ?? 0) < cutoff) continue;
    const t = transcriptPath(home, e.cwd, e.cliSessionId);
    const st = safeStat(t);
    if (!st) continue;
    const published = safeStat(join(mine, e.cliSessionId, "transcript.jsonl"));
    const publishedEntry = readJson(join(mine, e.cliSessionId, "entry.json"));
    const entryCurrent =
      publishedEntry?.lastActivityAt === e.lastActivityAt && publishedEntry?.title === e.title;
    if (published && published.size === st.size && entryCurrent) continue;
    exports.push({ cliSessionId: e.cliSessionId, title: e.title, transcript: t, bytes: st.size });
  }

  // Import: every other machine's published sessions.
  const imports: ImportAction[] = [];
  const skips: ImportSkip[] = [];
  const machines: string[] = [];
  const target = accounts.find((a) => a.accountUuid === opts.targetAccountUuid);
  const envDir =
    targetEnvDir(target) ??
    join(opts.dataDir, "claude-code-sessions", opts.targetAccountUuid, "shared");
  for (const machine of safeReaddir(opts.shareDir)) {
    if (machine === opts.machine) continue;
    const mdir = join(opts.shareDir, machine);
    const manifest = readJson(join(mdir, "manifest.json"));
    if (!manifest) continue;
    machines.push(machine);
    const remoteHome = typeof manifest.home === "string" ? manifest.home : null;
    const ids = safeReaddir(join(mdir, "sessions")).filter((id) => !id.startsWith("."));
    const files = ids.flatMap((id) => [
      join(mdir, "sessions", id, "entry.json"),
      join(mdir, "sessions", id, "transcript.jsonl"),
    ]);
    const placeholders = (opts.findPlaceholders ?? findPlaceholders)(files);
    const toDownload: string[] = [];
    for (const id of ids) {
      const sdir = join(mdir, "sessions", id);
      const entryFrom = join(sdir, "entry.json");
      if (placeholders.has(entryFrom) || placeholders.has(join(sdir, "transcript.jsonl"))) {
        toDownload.push(sdir);
        skips.push({ machine, cliSessionId: id, title: null, reason: "not-downloaded" });
        continue;
      }
      const remote = readJson(entryFrom);
      const remoteTranscript = join(sdir, "transcript.jsonl");
      const title = typeof remote?.title === "string" ? remote.title : null;
      if (!remote || typeof remote.cwd !== "string" || !safeStat(remoteTranscript)) {
        skips.push({ machine, cliSessionId: id, title, reason: "unreadable" });
        continue;
      }
      const remoteLast = typeof remote.lastActivityAt === "number" ? remote.lastActivityAt : null;
      if (remote.isArchived === true || (remoteLast ?? 0) < cutoff) continue;
      const cwd = remapHome(remote.cwd, remoteHome, home);
      if (!existsSync(cwd)) {
        skips.push({ machine, cliSessionId: id, title, reason: "missing-cwd" });
        continue;
      }
      const existing = local.get(id);
      const transcriptTo = transcriptPath(home, cwd, id);
      const localSt = safeStat(transcriptTo);
      const remoteSt = safeStat(remoteTranscript);
      let copyTranscript = false;
      if (!localSt) {
        copyTranscript = true;
      } else if (remoteSt && remoteSt.size > localSt.size) {
        if (now - localSt.mtimeMs < liveWindow) {
          skips.push({ machine, cliSessionId: id, title, reason: "live-here" });
          continue;
        }
        if (!isBytePrefix(transcriptTo, remoteTranscript)) {
          skips.push({ machine, cliSessionId: id, title, reason: "diverged" });
          continue;
        }
        copyTranscript = true;
      } else if (remoteSt && remoteSt.size < localSt.size && existing) {
        // Continued here since the other machine last saw it; keep ours.
        skips.push({ machine, cliSessionId: id, title, reason: "local-newer" });
        continue;
      }
      const entryStale =
        !existing ||
        (copyTranscript && (remoteLast ?? 0) > (existing.lastActivityAt ?? 0)) ||
        (copyTranscript && title !== existing.title);
      if (!copyTranscript && !entryStale) {
        skips.push({ machine, cliSessionId: id, title, reason: "up-to-date" });
        continue;
      }
      const sidecar = join(sdir, "sidecar");
      imports.push({
        kind: !existing ? (copyTranscript ? "new" : "entry-only") : "updated",
        machine,
        cliSessionId: id,
        title,
        cwd,
        transcriptFrom: copyTranscript ? remoteTranscript : null,
        transcriptTo,
        sidecarFrom: copyTranscript && existsSync(sidecar) ? sidecar : null,
        entryFrom,
        entryTo: existing
          ? existing.file
          : join(
              envDir,
              `${typeof remote.sessionId === "string" ? remote.sessionId : `local_${id}`}.json`,
            ),
        entryExists: Boolean(existing),
        remoteLastActivityAt: remoteLast,
      });
    }
    if (toDownload.length > 0) (opts.requestDownload ?? requestDownload)(toDownload);
  }
  return { exports, imports, skips, machines };
}

/** Write via a temp file + rename so a syncing reader never sees half a file. */
function atomicCopy(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = `${to}.harnery-tmp`;
  try {
    copyFileSync(from, tmp);
    renameSync(tmp, to);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function atomicWrite(to: string, content: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = `${to}.harnery-tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, to);
}

export function applyShare(
  plan: SharePlan,
  opts: ShareOptions,
): { exported: number; imported: number; failed: ImportFailure[] } {
  const home = opts.home ?? homedir();
  const mdir = join(opts.shareDir, opts.machine);
  const accounts = listAccounts(opts.dataDir);
  const local = localEntriesById(accounts);

  for (const x of plan.exports) {
    const e = local.get(x.cliSessionId);
    if (!e) continue;
    const sdir = join(mdir, "sessions", x.cliSessionId);
    atomicCopy(x.transcript, join(sdir, "transcript.jsonl"));
    const sidecar = join(dirname(x.transcript), x.cliSessionId);
    if (existsSync(sidecar))
      cpSync(sidecar, join(sdir, "sidecar"), { recursive: true, force: true });
    atomicCopy(e.file, join(sdir, "entry.json"));
  }
  atomicWrite(
    join(mdir, "manifest.json"),
    `${JSON.stringify({ machine: opts.machine, home, exported_at: new Date(opts.now ?? Date.now()).toISOString() }, null, 2)}\n`,
  );

  let imported = 0;
  const failed: ImportFailure[] = [];
  for (const x of plan.imports) {
    try {
      if (importOne(x, opts, home)) imported++;
    } catch (err) {
      failed.push({
        machine: x.machine,
        cliSessionId: x.cliSessionId,
        title: x.title,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { exported: plan.exports.length, imported, failed };
}

function importOne(x: ImportAction, opts: ShareOptions, home: string): boolean {
  const remote = readJson(x.entryFrom);
  if (!remote) return false;
  const remoteManifest = readJson(join(opts.shareDir, x.machine, "manifest.json"));
  const remoteHome = typeof remoteManifest?.home === "string" ? remoteManifest.home : null;
  if (x.transcriptFrom) atomicCopy(x.transcriptFrom, x.transcriptTo);
  if (x.sidecarFrom) {
    cpSync(x.sidecarFrom, join(dirname(x.transcriptTo), x.cliSessionId), {
      recursive: true,
      force: true,
    });
  }
  let entry: Record<string, unknown>;
  if (x.entryExists) {
    entry = readJson(x.entryTo) ?? {};
    if (typeof remote.title === "string") entry.title = remote.title;
    if (typeof remote.lastActivityAt === "number") entry.lastActivityAt = remote.lastActivityAt;
  } else {
    entry = { ...remote, isArchived: false };
    for (const k of ["cwd", "originCwd"]) {
      if (typeof entry[k] === "string") entry[k] = remapHome(entry[k] as string, remoteHome, home);
    }
    if (Array.isArray(entry.gitAnchors)) {
      entry.gitAnchors = (entry.gitAnchors as Record<string, unknown>[]).map((g) => ({
        ...g,
        gitRoot: typeof g.gitRoot === "string" ? remapHome(g.gitRoot, remoteHome, home) : g.gitRoot,
        commonDir:
          typeof g.commonDir === "string" ? remapHome(g.commonDir, remoteHome, home) : g.commonDir,
      }));
    }
  }
  atomicWrite(x.entryTo, `${JSON.stringify(entry)}\n`);
  return true;
}

export function shareSummary(plan: SharePlan) {
  return {
    machines: plan.machines,
    export: plan.exports.map((x) => ({
      title: x.title,
      cli_session_id: x.cliSessionId,
      bytes: x.bytes,
    })),
    import: plan.imports.map((x) => ({
      kind: x.kind,
      from_machine: x.machine,
      title: x.title,
      cli_session_id: x.cliSessionId,
    })),
    skipped: plan.skips
      .filter((s) => s.reason !== "up-to-date" && s.reason !== "not-downloaded")
      .map((s) => ({
        from_machine: s.machine,
        title: s.title,
        cli_session_id: s.cliSessionId,
        reason: s.reason,
      })),
    not_downloaded: plan.skips.filter((s) => s.reason === "not-downloaded").length,
    up_to_date: plan.skips.filter((s) => s.reason === "up-to-date").length,
  };
}
