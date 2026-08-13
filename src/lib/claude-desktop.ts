import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Claude desktop app session-index access.
 *
 * The Claude desktop app keeps each signed-in account's Claude Code session
 * sidebar as plain JSON files:
 *
 *   <dataDir>/claude-code-sessions/<account-uuid>/<env-id>/local_<uuid>.json
 *
 * One file per sidebar entry: { sessionId, cliSessionId, cwd, title, ... }.
 * Nothing inside the file binds it to an account — the scoping is purely
 * which <account-uuid> directory it sits in, and the transcripts themselves
 * live in the (account-agnostic) `~/.claude/projects/` tree of the runtime
 * environment. So when a user signs out of account A and into account B,
 * their sessions "disappear" from the sidebar even though every byte is
 * still on disk. Copying an entry file into another account's directory
 * makes the session visible (and resumable) there.
 *
 * These helpers locate the desktop app's data directory (including the
 * Windows one from inside WSL, where the app runs on the Windows side but
 * the CLI runs in the distro), enumerate the per-account entries, and
 * plan/apply cross-account mirrors. The file format is the desktop app's
 * private state, not a public API — everything here treats it read-mostly
 * and copies files verbatim rather than rewriting them.
 */

export interface DesktopSessionEntry {
  /** Absolute path of the local_*.json entry file. */
  file: string;
  /** Account UUID directory the entry sits under (= sidebar scoping). */
  accountUuid: string;
  /** Environment directory between account and entry (VM/env identity). */
  envId: string;
  /** The entry's own id (usually "local_<uuid>", mirrors the filename). */
  sessionId: string | null;
  /** The Claude Code session id — matches the JSONL transcript filename. */
  cliSessionId: string | null;
  cwd: string | null;
  title: string | null;
  model: string | null;
  isArchived: boolean;
  createdAt: number | null;
  lastActivityAt: number | null;
}

export interface DesktopAccount {
  accountUuid: string;
  path: string;
  entries: DesktopSessionEntry[];
}

export interface MirrorAction {
  from: string;
  to: string;
  entry: DesktopSessionEntry;
  targetAccountUuid: string;
}

export interface MirrorPlan {
  actions: MirrorAction[];
  /** Entries skipped because the target already lists that cliSessionId. */
  skippedExisting: number;
  /** Entries skipped because they are archived (opt in via includeArchived). */
  skippedArchived: number;
}

export type DesktopLifecycleState = "active" | "blocked" | "done";

export interface DesktopLifecycleRecord {
  state: DesktopLifecycleState;
  updatedAt: string;
  instanceId: string | null;
  sessionId: string | null;
  reason: string | null;
}

export type DesktopTidySource = "lifecycle" | "legacy-prefix";

export interface DesktopTidyAction {
  entry: DesktopSessionEntry;
  source: DesktopTidySource;
  lifecycle: DesktopLifecycleRecord | null;
}

export type DesktopTidySkipReason =
  | "already_archived"
  | "blocked_title"
  | "lifecycle_active"
  | "lifecycle_blocked"
  | "unmatched";

export interface DesktopTidySkip {
  entry: DesktopSessionEntry;
  reason: DesktopTidySkipReason;
  lifecycle: DesktopLifecycleRecord | null;
}

export interface DesktopTidyPlan {
  actions: DesktopTidyAction[];
  skipped: DesktopTidySkip[];
}

export interface DesktopTidyOptions {
  /** Restrict entries to accounts whose UUID starts with one of these prefixes. */
  accounts?: string[];
  /** Accept an unmatched historical `[DONE]` title as a compatibility fallback. */
  includeLegacyPrefix?: boolean;
}

const SESSIONS_DIRNAME = "claude-code-sessions";

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/**
 * Candidate desktop-app data directories for this machine, most specific
 * first. Only directories that exist AND contain a claude-code-sessions/
 * subdirectory are returned. Precedence: explicit arg, then
 * HARNERY_CLAUDE_DESKTOP_DIR, then platform defaults (on WSL that means
 * scanning every /mnt/c/Users/<user>/AppData/Roaming/Claude).
 */
export function findDesktopDataDirs(explicit?: string): string[] {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  else if (process.env.HARNERY_CLAUDE_DESKTOP_DIR) {
    candidates.push(process.env.HARNERY_CLAUDE_DESKTOP_DIR);
  } else {
    const home = homedir();
    if (process.platform === "darwin") {
      candidates.push(join(home, "Library", "Application Support", "Claude"));
    } else if (process.platform === "win32") {
      if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, "Claude"));
      candidates.push(join(home, "AppData", "Roaming", "Claude"));
    } else {
      candidates.push(join(home, ".config", "Claude"));
      if (isWsl()) {
        for (const usersRoot of ["/mnt/c/Users"]) {
          if (!existsSync(usersRoot)) continue;
          for (const user of safeReaddir(usersRoot)) {
            candidates.push(join(usersRoot, user, "AppData", "Roaming", "Claude"));
          }
        }
      }
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (existsSync(join(dir, SESSIONS_DIRNAME))) out.push(dir);
  }
  return out;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readEntry(file: string, accountUuid: string, envId: string): DesktopSessionEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const d = raw as Record<string, unknown>;
  const str = (k: string): string | null => (typeof d[k] === "string" ? (d[k] as string) : null);
  const num = (k: string): number | null => (typeof d[k] === "number" ? (d[k] as number) : null);
  return {
    file,
    accountUuid,
    envId,
    sessionId: str("sessionId"),
    cliSessionId: str("cliSessionId"),
    cwd: str("cwd"),
    title: str("title"),
    model: str("model"),
    isArchived: d.isArchived === true,
    createdAt: num("createdAt"),
    lastActivityAt: num("lastActivityAt"),
  };
}

/** Enumerate every account directory + its session entries under one data dir. */
export function listAccounts(dataDir: string): DesktopAccount[] {
  const root = join(dataDir, SESSIONS_DIRNAME);
  const accounts: DesktopAccount[] = [];
  for (const accountUuid of safeReaddir(root)) {
    const accountPath = join(root, accountUuid);
    if (!isDir(accountPath)) continue;
    const entries: DesktopSessionEntry[] = [];
    for (const envId of safeReaddir(accountPath)) {
      const envPath = join(accountPath, envId);
      if (!isDir(envPath)) continue;
      for (const f of safeReaddir(envPath)) {
        if (!f.endsWith(".json")) continue;
        const entry = readEntry(join(envPath, f), accountUuid, envId);
        if (entry) entries.push(entry);
      }
    }
    entries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
    accounts.push({ accountUuid, path: accountPath, entries });
  }
  accounts.sort(
    (a, b) =>
      (b.entries[0]?.lastActivityAt ?? 0) - (a.entries[0]?.lastActivityAt ?? 0) ||
      a.accountUuid.localeCompare(b.accountUuid),
  );
  return accounts;
}

/**
 * The account the runtime environment's Claude Code CLI is signed into,
 * read from ~/.claude.json (best-effort; null when unavailable). Lets the
 * command label an otherwise-opaque account UUID with an email address.
 */
export function readCliAccount(): { accountUuid: string; email: string | null } | null {
  try {
    const raw = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const oa = raw.oauthAccount as Record<string, unknown> | undefined;
    if (!oa || typeof oa.accountUuid !== "string") return null;
    return {
      accountUuid: oa.accountUuid,
      email: typeof oa.emailAddress === "string" ? oa.emailAddress : null,
    };
  } catch {
    return null;
  }
}

export interface MirrorOptions {
  /** Restrict targets to accounts whose uuid starts with one of these. */
  to?: string[];
  /** Restrict sources to accounts whose uuid starts with one of these. */
  from?: string[];
  /**
   * Selectors: each matches a cliSessionId / sessionId exactly, or a title
   * case-insensitively as a substring. Empty/undefined = every entry.
   */
  sessions?: string[];
  includeArchived?: boolean;
}

export function entryMatchesSelector(entry: DesktopSessionEntry, selector: string): boolean {
  if (entry.cliSessionId === selector || entry.sessionId === selector) return true;
  // Optional chain rather than a null guard: the reader normalises a missing
  // title to null, but this is exported, and a hand-built entry with an absent
  // title would slip past `!== null` and then throw on the method call.
  return entry.title?.toLowerCase().includes(selector.toLowerCase()) ?? false;
}

/**
 * Plan the copies that would make each target account list the selected
 * sessions. Union semantics: every entry a source account has and a target
 * account lacks (keyed by cliSessionId, falling back to filename) becomes a
 * copy action. Idempotent by construction — planning again after applying
 * yields zero actions.
 */
export function planMirror(accounts: DesktopAccount[], opts: MirrorOptions = {}): MirrorPlan {
  const matchPrefix = (uuid: string, prefixes?: string[]) =>
    !prefixes || prefixes.length === 0 || prefixes.some((p) => uuid.startsWith(p));

  const targets = accounts.filter((a) => matchPrefix(a.accountUuid, opts.to));
  const sources = accounts.filter((a) => matchPrefix(a.accountUuid, opts.from));

  const actions: MirrorAction[] = [];
  let skippedExisting = 0;
  let skippedArchived = 0;

  for (const target of targets) {
    const have = new Set<string>();
    for (const e of target.entries) {
      if (e.cliSessionId) have.add(e.cliSessionId);
      have.add(basename(e.file));
    }
    for (const source of sources) {
      if (source.accountUuid === target.accountUuid) continue;
      for (const entry of source.entries) {
        if (opts.sessions?.length && !opts.sessions.some((s) => entryMatchesSelector(entry, s))) {
          continue;
        }
        const key = entry.cliSessionId ?? basename(entry.file);
        if (have.has(key) || have.has(basename(entry.file))) {
          skippedExisting++;
          continue;
        }
        if (entry.isArchived && !opts.includeArchived) {
          skippedArchived++;
          continue;
        }
        have.add(key);
        actions.push({
          from: entry.file,
          to: join(target.path, entry.envId, basename(entry.file)),
          entry,
          targetAccountUuid: target.accountUuid,
        });
      }
    }
  }
  return { actions, skippedExisting, skippedArchived };
}

/** Apply a plan: verbatim file copies (never rewrites entry contents). */
export function applyMirror(plan: MirrorPlan): { copied: number } {
  let copied = 0;
  for (const action of plan.actions) {
    mkdirSync(dirname(action.to), { recursive: true });
    copyFileSync(action.from, action.to);
    copied++;
  }
  return { copied };
}

/**
 * Read the latest durable lifecycle declaration for every Harnery session.
 *
 * The canonical ledger rotates into `events-*.ndjson` archives. Stream each
 * file rather than loading the whole history into one string, then compare
 * event timestamps because adapter replay may append an older event later.
 * Records are indexed by both session_id and instance_id so a desktop
 * cliSessionId can match either identity shape used by older adapters.
 */
export async function readDesktopLifecycleIndex(
  coordRoot: string,
): Promise<Map<string, DesktopLifecycleRecord>> {
  const coordDir = join(coordRoot, ".harnery");
  const archives = safeReaddir(coordDir)
    .filter((name) => name.startsWith("events-") && name.endsWith(".ndjson"))
    .sort();
  const files = [...archives, "events.ndjson"]
    .map((name) => join(coordDir, name))
    .filter((path) => existsSync(path));

  const records = new Map<string, DesktopLifecycleRecord>();
  const timestamps = new Map<string, number>();

  for (const file of files) {
    let lines: ReturnType<typeof createInterface> | null = null;
    try {
      lines = createInterface({
        input: createReadStream(file, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        if (!raw || typeof raw !== "object") continue;
        const event = raw as Record<string, unknown>;
        if (event.event_type !== "state.task_state" || typeof event.ts !== "string") continue;
        const data = event.data;
        if (!data || typeof data !== "object") continue;
        const state = (data as Record<string, unknown>).state;
        if (state !== "active" && state !== "blocked" && state !== "done") continue;

        const instanceId = typeof event.instance_id === "string" ? event.instance_id : null;
        const sessionId = typeof event.session_id === "string" ? event.session_id : null;
        const reasonValue = (data as Record<string, unknown>).reason;
        const record: DesktopLifecycleRecord = {
          state,
          updatedAt: event.ts,
          instanceId,
          sessionId,
          reason: typeof reasonValue === "string" && reasonValue.length > 0 ? reasonValue : null,
        };
        const timestamp = Number.isFinite(Date.parse(event.ts)) ? Date.parse(event.ts) : 0;
        for (const key of new Set(
          [sessionId, instanceId].filter((value): value is string => !!value),
        )) {
          const priorTimestamp = timestamps.get(key);
          if (priorTimestamp !== undefined && priorTimestamp > timestamp) continue;
          timestamps.set(key, timestamp);
          records.set(key, record);
        }
      }
    } catch {
      // A missing or concurrently rotated event file cannot make tidy unsafe:
      // absent lifecycle evidence leaves entries unmatched and therefore skipped.
    } finally {
      lines?.close();
    }
  }

  return records;
}

/** Select desktop entries whose durable lifecycle is done. */
export function planTidy(
  accounts: DesktopAccount[],
  lifecycleBySession: ReadonlyMap<string, DesktopLifecycleRecord>,
  opts: DesktopTidyOptions = {},
): DesktopTidyPlan {
  const selectedAccounts = accounts.filter(
    (account) =>
      !opts.accounts?.length ||
      opts.accounts.some((prefix) => account.accountUuid.startsWith(prefix)),
  );
  const actions: DesktopTidyAction[] = [];
  const skipped: DesktopTidySkip[] = [];

  for (const account of selectedAccounts) {
    for (const entry of account.entries) {
      const lifecycle = lifecycleForEntry(entry, lifecycleBySession);
      if (entry.isArchived) {
        skipped.push({ entry, reason: "already_archived", lifecycle });
        continue;
      }
      if (hasLifecyclePrefix(entry.title, "BLOCKED")) {
        skipped.push({ entry, reason: "blocked_title", lifecycle });
        continue;
      }
      if (lifecycle) {
        if (lifecycle.state === "done") {
          actions.push({ entry, source: "lifecycle", lifecycle });
        } else {
          skipped.push({ entry, reason: `lifecycle_${lifecycle.state}`, lifecycle });
        }
        continue;
      }
      if (opts.includeLegacyPrefix && hasLifecyclePrefix(entry.title, "DONE")) {
        actions.push({ entry, source: "legacy-prefix", lifecycle: null });
      } else {
        skipped.push({ entry, reason: "unmatched", lifecycle: null });
      }
    }
  }

  return { actions, skipped };
}

/** Apply a tidy plan with same-directory temp files and atomic renames. */
export function applyTidy(plan: DesktopTidyPlan): { archived: number; alreadyArchived: number } {
  let archived = 0;
  let alreadyArchived = 0;
  for (const action of plan.actions) {
    if (archiveEntry(action.entry.file)) archived++;
    else alreadyArchived++;
  }
  return { archived, alreadyArchived };
}

function lifecycleForEntry(
  entry: DesktopSessionEntry,
  lifecycleBySession: ReadonlyMap<string, DesktopLifecycleRecord>,
): DesktopLifecycleRecord | null {
  if (entry.cliSessionId) {
    const lifecycle = lifecycleBySession.get(entry.cliSessionId);
    if (lifecycle) return lifecycle;
  }
  return entry.sessionId ? (lifecycleBySession.get(entry.sessionId) ?? null) : null;
}

function hasLifecyclePrefix(title: string | null, state: "BLOCKED" | "DONE"): boolean {
  if (!title) return false;
  return new RegExp(`^\\s*\\[${state}\\](?:\\s*-|\\s|$)`, "i").test(title);
}

function archiveEntry(file: string): boolean {
  const text = readFileSync(file, "utf8");
  const raw = JSON.parse(text) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`desktop entry is not a JSON object: ${file}`);
  }
  const entry = raw as Record<string, unknown>;
  if (entry.isArchived === true) return false;
  entry.isArchived = true;

  const pretty = text.includes("\n");
  const trailingNewline = text.endsWith("\n") ? "\n" : "";
  const next = `${JSON.stringify(entry, null, pretty ? 2 : undefined)}${trailingNewline}`;
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, next, { encoding: "utf8", mode: statSync(file).mode });
    renameSync(temp, file);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // rename already consumed the temp file, or creation failed before it existed
    }
  }
  return true;
}
