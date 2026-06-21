/**
 * Coord-state reader for the standalone harnery web UI.
 *
 * Resolves the `.harnery/` directory from:
 *   1. `HARNERY_COORD_ROOT` env var (set by `harn web up` to the user's cwd)
 *   2. Walk up from process.cwd() looking for a `.harnery/` directory
 *
 * Reads heartbeats, councils, events, and scratchpads. Invalid entries are
 * reported as `meta.invalid` rather than crashing the page.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  type ContributionMatrix,
  buildContributionMatrix,
  countConsecutiveAllTrivialRounds,
  formatDuration,
} from "./changelog-parser";
import { countConsecutiveAllTrivialRoundsFromTags } from "./council-triviality";

let cachedRoot: string | null = null;

/** Reset the memoized root (tests only; route-level tests repoint
 * HARNERY_COORD_ROOT at a temp fixture and need the cache dropped). */
export function __resetCoordRootCache(): void {
  cachedRoot = null;
}

export function coordRoot(): string {
  if (cachedRoot) return cachedRoot;
  const envRoot = process.env.HARNERY_COORD_ROOT?.trim();
  if (envRoot && existsSync(path.join(envRoot, ".harnery"))) {
    cachedRoot = envRoot;
    return envRoot;
  }
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, ".harnery"))) {
      cachedRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedRoot = dir;
  return dir;
}

export function harneryDir(): string {
  return path.join(coordRoot(), ".harnery");
}

export function activeDir(): string {
  return path.join(harneryDir(), "active");
}

export function councilsDir(): string {
  return path.join(harneryDir(), "councils");
}

export function scratchDir(): string {
  return path.join(harneryDir(), "scratch");
}

export function eventsPath(): string {
  return path.join(harneryDir(), "events.ndjson");
}

export interface Heartbeat {
  instance_id: string;
  name: string;
  kind?: string;
  platform?: string | null;
  session_id?: string;
  started_at?: string;
  last_heartbeat: string;
  files_touched: string[];
  task?: string | null;
  task_updated_at?: string | null;
  turn_summary?: string | null;
  turn_summary_updated_at?: string | null;
  last_tool?: string | null;
  last_tool_target?: string | null;
  model?: string | null;
  age_seconds: number;
}

export interface InvalidHeartbeat {
  file: string;
  issue: string;
}

export interface AgentsSnapshot {
  active: Heartbeat[];
  stale: Heartbeat[];
  claims: ClaimRow[];
  meta: {
    scanned_dir: string;
    count: number;
    invalid: InvalidHeartbeat[];
    stale_threshold_seconds: number;
  };
}

export interface ClaimRow {
  instance_id: string;
  name: string;
  platform: string | null | undefined;
  path: string;
  last_heartbeat: string;
}

const STALE_AGE_SECONDS = 5 * 60;

function isHeartbeatShape(v: unknown): v is Omit<Heartbeat, "age_seconds"> {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.instance_id === "string" &&
    typeof r.name === "string" &&
    typeof r.last_heartbeat === "string" &&
    Array.isArray(r.files_touched)
  );
}

function readHeartbeats(): { all: Heartbeat[]; invalid: InvalidHeartbeat[]; dir: string } {
  const dir = activeDir();
  const invalid: InvalidHeartbeat[] = [];
  const all: Heartbeat[] = [];

  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch (err) {
    invalid.push({ file: dir, issue: `active dir missing: ${(err as Error).message}` });
    return { all, invalid, dir };
  }

  const now = Date.now();
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const full = path.join(dir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(full, "utf-8"));
    } catch (err) {
      invalid.push({ file, issue: `parse error: ${(err as Error).message}` });
      continue;
    }
    if (!isHeartbeatShape(parsed)) {
      invalid.push({ file, issue: "missing required fields" });
      continue;
    }
    const ts = Date.parse(parsed.last_heartbeat);
    const ageSec = Number.isFinite(ts) ? Math.max(0, Math.floor((now - ts) / 1000)) : 0;
    all.push({ ...parsed, age_seconds: ageSec });
  }

  all.sort((a, b) => b.last_heartbeat.localeCompare(a.last_heartbeat));
  return { all, invalid, dir };
}

export function readAgents(): AgentsSnapshot {
  const { all, invalid, dir } = readHeartbeats();

  const active = all.filter((h) => h.age_seconds < STALE_AGE_SECONDS);
  const stale = all.filter((h) => h.age_seconds >= STALE_AGE_SECONDS);

  const claims: ClaimRow[] = [];
  for (const hb of all) {
    for (const p of hb.files_touched) {
      claims.push({
        instance_id: hb.instance_id,
        name: hb.name,
        platform: hb.platform,
        path: p,
        last_heartbeat: hb.last_heartbeat,
      });
    }
  }

  return {
    active,
    stale,
    claims,
    meta: {
      scanned_dir: dir,
      count: all.length,
      invalid,
      stale_threshold_seconds: STALE_AGE_SECONDS,
    },
  };
}

export function readAgent(instanceId: string): Heartbeat | null {
  const { all } = readHeartbeats();
  return all.find((h) => h.instance_id === instanceId) ?? null;
}

/**
 * Reconstruct a read-only `Heartbeat` for an agent whose live heartbeat is gone
 * (session ended, or the file was pruned) but whose durable identity persists in
 * the append-only event log. Mirrors what `buildEndedAgentSummaries` does for the
 * hover card, so the standalone `/agents/[id]` page works for ended agents too
 * instead of 404ing.
 *
 * Only the fields that survive a session are populated: name / platform /
 * session_id / started_at from the `session.start` (or `subagent.start`) record,
 * and `last_heartbeat` set to the agent's most-recent event ts (a real "last
 * seen", more accurate than the start ts). The live-only fields (task,
 * files_touched, last_tool, model, turn_summary) are intentionally empty: they
 * lived in the heartbeat and don't outlast it. Callers distinguish this from a
 * live heartbeat by checking `readAgent` first and gate live-only mutation
 * actions (heal / kill / nudge / end-session) on that.
 *
 * Returns null when no identity exists for the instance (→ genuine notFound).
 */
export function readEndedAgent(instanceId: string): Heartbeat | null {
  const identity = readInstanceIdentities()[instanceId];
  if (!identity) return null;
  // Newest event ts for this instance = best "last seen" proxy. readEvents
  // returns rows newest-first, so rows[0] is the most recent.
  const recent = readEvents({ instanceId, limit: 1 }).rows[0];
  const lastSeen = recent?.ts ?? identity.last_ts ?? identity.started_at ?? "";
  const ts = Date.parse(lastSeen);
  const ageSec = Number.isFinite(ts) ? Math.max(0, Math.floor((Date.now() - ts) / 1000)) : 0;
  return {
    instance_id: identity.instance_id,
    name: identity.name.startsWith("agent-") ? identity.name.slice("agent-".length) : identity.name,
    kind: identity.kind,
    platform: identity.platform ?? null,
    session_id: identity.session_id ?? undefined,
    started_at: identity.started_at ?? undefined,
    last_heartbeat: lastSeen,
    files_touched: [],
    task: null,
    turn_summary: null,
    last_tool: null,
    last_tool_target: null,
    model: null,
    age_seconds: ageSec,
  };
}

export interface ScratchEntry {
  ts_chicago: string;
  ts_iso: string | null;
  category: string;
  body: string;
}

/**
 * Parse a Chicago wall-clock header timestamp like `2026-05-28 9:21 AM CDT`
 * back to a canonical ISO string with the right offset (CDT=-05:00,
 * CST=-06:00). Returns null for unrecognized shapes; `<FormattedDateTime>`
 * tolerates null + renders an em dash.
 */
function parseChicagoStampToIso(s: string): string | null {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2}) (AM|PM) (CDT|CST)$/);
  if (!m) return null;
  const [, y, mo, d, hRaw, min, ampm, tz] = m;
  let h = Number.parseInt(hRaw, 10);
  if (ampm === "PM" && h !== 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  const offset = tz === "CDT" ? "-05:00" : "-06:00";
  return `${y}-${mo}-${d}T${h.toString().padStart(2, "0")}:${min}:00${offset}`;
}

export interface ScratchDoc {
  exists: boolean;
  path: string;
  bytes: number;
  entries: ScratchEntry[];
}

// Scratchpad entries look like: `## 2026-05-27 10:39 AM CDT · handoff`
// (see src/lib/scratch/index.ts; appendEntry emits this format).
const SCRATCH_HEADER_RE =
  /^##\s+(?<ts>.+?)\s+·\s+(?<cat>note|plan|decision|blocker|question|done|handoff)\s*$/i;

export function readScratch(instanceId: string): ScratchDoc {
  const p = path.join(scratchDir(), `${instanceId}.md`);
  if (!existsSync(p)) {
    return { exists: false, path: p, bytes: 0, entries: [] };
  }
  const text = readFileSync(p, "utf-8");
  const bytes = Buffer.byteLength(text, "utf-8");
  const entries: ScratchEntry[] = [];
  const lines = text.split("\n");
  let current: ScratchEntry | null = null;
  const bodyBuf: string[] = [];
  for (const line of lines) {
    const m = SCRATCH_HEADER_RE.exec(line);
    if (m) {
      if (current) {
        current.body = bodyBuf.join("\n").trim();
        entries.push(current);
        bodyBuf.length = 0;
      }
      const tsChicago = m.groups?.ts ?? "";
      current = {
        ts_chicago: tsChicago,
        ts_iso: parseChicagoStampToIso(tsChicago),
        category: (m.groups?.cat ?? "").toLowerCase(),
        body: "",
      };
    } else if (current) {
      bodyBuf.push(line);
    }
  }
  if (current) {
    current.body = bodyBuf.join("\n").trim();
    entries.push(current);
  }
  // File is newest-first (appendEntry unshifts). Keep that order; the panel's
  // "Newest" default toggle relies on the array matching the label.
  return { exists: true, path: p, bytes, entries };
}

export interface ScratchArchive {
  filename: string;
  path: string;
  bytes: number;
  archived_at: string;
  is_pre_ui_edit: boolean;
}

/**
 * List archived scratchpads for one owner. Archive filenames follow two
 * shapes from `harnery/src/lib/scratch/index.ts`:
 *
 *   <owner>-<iso>.md            auto-archive on SessionEnd
 *   <owner>-pre-ui-<iso>.md     pre-edit snapshot from the web UI's wholesale Replace
 *
 * Both use `2026-05-28T14-06-19-123Z` style ISO with `:` swapped to `-` for
 * filesystem safety; we revert that to a real ISO for `archived_at`.
 */
export function listScratchArchives(instanceId: string): ScratchArchive[] {
  const dir = path.join(scratchDir(), "archived");
  if (!existsSync(dir)) return [];
  const prefix = `${instanceId}-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ScratchArchive[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".md")) continue;
    const full = path.join(dir, name);
    let bytes = 0;
    try {
      bytes = statSync(full).size;
    } catch {
      continue;
    }
    // Strip the `<owner>-` prefix and `.md` suffix; what's left is either
    // `pre-ui-<ts>` or `<ts>`.
    const stem = name.slice(prefix.length, -3);
    const isPreUi = stem.startsWith("pre-ui-");
    const tsPart = isPreUi ? stem.slice("pre-ui-".length) : stem;
    // Filename ts: `2026-05-28T14-06-19-123Z` → ISO `2026-05-28T14:06:19.123Z`.
    // Match the date prefix, then a `T`, then HH-MM-SS, optional `-mmm`, `Z`.
    const m = tsPart.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:-(\d{3}))?Z$/);
    let archivedAt = "";
    if (m) {
      const [, day, hh, mm, ss, ms] = m;
      archivedAt = `${day}T${hh}:${mm}:${ss}${ms ? `.${ms}` : ""}Z`;
    }
    out.push({
      filename: name,
      path: full,
      bytes,
      archived_at: archivedAt,
      is_pre_ui_edit: isPreUi,
    });
  }
  // Newest first.
  out.sort((a, b) => (a.archived_at < b.archived_at ? 1 : -1));
  return out;
}

export function readScratchArchive(instanceId: string, filename: string): string | null {
  // Tight whitelist: must start with the owner prefix and end in `.md`, no slashes.
  if (
    !filename.startsWith(`${instanceId}-`) ||
    !filename.endsWith(".md") ||
    filename.includes("/") ||
    filename.includes("..")
  ) {
    return null;
  }
  const p = path.join(scratchDir(), "archived", filename);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

export interface EventRow {
  schema_version: number;
  event_id: string;
  event_type: string;
  ts: string;
  instance_id?: string;
  session_id?: string;
  harness?: string;
  source?: string;
  data?: Record<string, unknown>;
}

export interface EventsResponse {
  rows: EventRow[];
  meta: {
    path: string;
    total_lines: number;
    returned: number;
  };
}

export function readEvents(
  opts: { limit?: number; instanceId?: string; type?: string } = {},
): EventsResponse {
  const p = eventsPath();
  const limit = opts.limit ?? 200;
  if (!existsSync(p)) {
    return { rows: [], meta: { path: p, total_lines: 0, returned: 0 } };
  }
  const text = readFileSync(p, "utf-8");
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const out: EventRow[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (out.length >= limit) break;
    try {
      const row = JSON.parse(lines[i]) as EventRow;
      if (opts.instanceId && row.instance_id !== opts.instanceId) continue;
      if (opts.type && row.event_type !== opts.type) continue;
      out.push(row);
    } catch {
      // skip malformed line
    }
  }
  return { rows: out, meta: { path: p, total_lines: lines.length, returned: out.length } };
}

/** Durable identity for one agent instance, harvested from the append-only
 * event log (not from heartbeats, which are deleted on session end). */
export interface InstanceIdentity {
  instance_id: string;
  name: string;
  /** "session" for a main agent (from `session.start`) or "subagent" (from
   * `subagent.start`). */
  kind: "session" | "subagent";
  /** subagents only: the Agent-tool type (Explore, general-purpose, …). */
  agent_type?: string | null;
  /** subagents only: the dispatching parent's session id (= parent instance_id). */
  session_id?: string | null;
  platform?: string | null;
  /** Model from this instance's most recent `turn.stop` ("what model did it
   * last use"), survives the heartbeat and tracks mid-session model switches. */
  model?: string | null;
  started_at?: string | null;
  /** ts of the start event: a recency proxy for agents that have since ended. */
  last_ts?: string | null;
}

/**
 * Incremental `instance_id → identity` index over the append-only event log.
 *
 * `readInstanceIdentities` used to `readFileSync` the entire stream (now ~68MB,
 * growing forever, since events.ndjson is a deliberate immutable ledger) on every
 * web request, just to harvest the two sparse start events per agent. Because
 * the log is append-only, byte offsets never shift, so we can persist a derived
 * map + the byte offset consumed so far and on each call read only the appended
 * delta `[offset, size)`. Steady state (nothing new) is a single `statSync`.
 *
 * Persisted at `.harnery/.identity-index.json` (gitignored derived state, like
 * `.events-cursor`) so a fresh web-server process doesn't pay one O(file) read
 * on its first request; an in-memory cache makes repeat calls in-process free.
 */
export interface IdentityIndex {
  /** Bump when the parser learns new event types/fields. A persisted index
   * built by an older parser has already consumed the bytes that carry the new
   * data, so a version mismatch forces one full rebuild. */
  version?: number;
  /** Bytes of events.ndjson consumed so far, always a line boundary. */
  offset: number;
  identities: Record<string, InstanceIdentity>;
}

/** v2: turn.stop model harvesting (2026-06-10). */
const IDENTITY_INDEX_VERSION = 2;

let identityIndexCache: IdentityIndex | null = null;

/** Parse `session.start` / `subagent.start` / `turn.stop` rows out of an
 *  ndjson chunk and merge them into `into` (latest start wins per instance_id;
 *  a turn.stop's `data.model` folds onto the existing identity, "what model
 *  did this agent last use"). Pure; exported for tests. The substring
 *  pre-filter skips JSON.parse for lines that aren't one of these events. */
export function mergeIdentitiesFromChunk(
  chunk: string,
  into: Record<string, InstanceIdentity>,
): Record<string, InstanceIdentity> {
  for (const line of chunk.split("\n")) {
    const isSession = line.includes('"session.start"');
    const isSubagent = !isSession && line.includes('"subagent.start"');
    const isTurnStop = !isSession && !isSubagent && line.includes('"turn.stop"');
    if (!isSession && !isSubagent && !isTurnStop) continue;
    try {
      if (isTurnStop) {
        const row = JSON.parse(line) as {
          instance_id?: string;
          data?: { model?: string };
        };
        const model = row.data?.model;
        // A turn.stop always follows its session.start in the append-only log,
        // so the identity exists; if the start was never captured, a model with
        // no name attached is unusable, so skip rather than synthesize.
        if (row.instance_id && model && into[row.instance_id]) {
          into[row.instance_id].model = model;
        }
        continue;
      }
      const row = JSON.parse(line) as {
        instance_id?: string;
        session_id?: string;
        ts?: string;
        data?: { name?: string; agent_type?: string; platform?: string; started_at?: string };
      };
      const name = row.data?.name;
      if (!row.instance_id || !name) continue;
      into[row.instance_id] = {
        instance_id: row.instance_id,
        name,
        kind: isSession ? "session" : "subagent",
        agent_type: isSubagent ? (row.data?.agent_type ?? null) : null,
        session_id: row.session_id ?? null,
        platform: row.data?.platform ?? null,
        // A re-emitted start (session resume) must not wipe a model already
        // harvested from this instance's earlier turn.stops.
        model: into[row.instance_id]?.model ?? null,
        started_at: row.data?.started_at ?? null,
        last_ts: row.ts ?? null,
      };
    } catch {
      // skip malformed line
    }
  }
  return into;
}

/** Read bytes `[start, end)` of a file as UTF-8 without loading the rest. Both
 *  ends are line boundaries in this index, so no partial-multibyte decode. */
function readRange(p: string, start: number, end: number): string {
  const len = end - start;
  if (len <= 0) return "";
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(p, "r");
  try {
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.toString("utf8", 0, read);
  } finally {
    closeSync(fd);
  }
}

function loadPersistedIndex(indexPath: string): IdentityIndex {
  try {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as Partial<IdentityIndex>;
    if (
      parsed.version === IDENTITY_INDEX_VERSION &&
      typeof parsed.offset === "number" &&
      parsed.identities &&
      typeof parsed.identities === "object"
    ) {
      return {
        version: parsed.version,
        offset: parsed.offset,
        identities: parsed.identities as Record<string, InstanceIdentity>,
      };
    }
  } catch {
    // missing or corrupt → rebuild from scratch
  }
  // Missing, corrupt, or built by an older parser version → one full re-scan.
  return { offset: 0, identities: {} };
}

function persistIndex(indexPath: string, idx: IdentityIndex): void {
  try {
    const tmp = `${indexPath}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(idx), "utf8");
    renameSync(tmp, indexPath);
  } catch {
    // best-effort; the in-memory cache is still authoritative this process
  }
}

/**
 * Engine for the incremental identity index. Resolves paths from `root`
 * directly (not the module-cached coordRoot) so it's testable against a temp
 * dir. `prev` is the prior index (in-memory cache or null on cold start);
 * returns the refreshed index after consuming any appended events.
 */
export function refreshIdentityIndex(root: string, prev: IdentityIndex | null): IdentityIndex {
  const p = path.join(root, ".harnery", "events.ndjson");
  const indexPath = path.join(root, ".harnery", ".identity-index.json");
  if (!existsSync(p)) return prev ?? { offset: 0, identities: {} };

  let size: number;
  try {
    size = statSync(p).size;
  } catch {
    return prev ?? { offset: 0, identities: {} };
  }

  // Cold start: hydrate from the persisted index so we don't re-read the whole
  // log on the first request after a process restart.
  let { offset, identities } = prev ?? loadPersistedIndex(indexPath);

  // File shrank (deleted + recreated) → the old offset is meaningless; rebuild.
  if (size < offset) {
    offset = 0;
    identities = {};
  }

  // Nothing new since last index → return as-is (the steady-state fast path).
  if (size === offset) return { offset, identities };

  // Read only the appended delta. Advance the offset to the LAST COMPLETE line
  // so a torn final write (statSync caught mid-append) is re-read next call
  // rather than dropped.
  const delta = readRange(p, offset, size);
  const lastNl = delta.lastIndexOf("\n");
  if (lastNl < 0) {
    // No complete line yet; don't advance.
    return { offset, identities };
  }
  const complete = delta.slice(0, lastNl + 1);
  mergeIdentitiesFromChunk(complete, identities);
  const next: IdentityIndex = {
    version: IDENTITY_INDEX_VERSION,
    offset: offset + Buffer.byteLength(complete, "utf8"),
    identities,
  };
  persistIndex(indexPath, next);
  return next;
}

/**
 * Map `instance_id → identity`, harvested from `session.start` (main agents)
 * and `subagent.start` (Agent-tool dispatches) events in the canonical log.
 * Backed by the incremental index above, so cost is O(new events) not O(file).
 *
 * Why the event log and not heartbeats: heartbeat files in `.harnery/active/`
 * are deleted when a session ends, so they only name *live* agents. These start
 * events persist in the append-only log, so a name resolves for the life of the
 * log, including for agents (main and subagent alike) that have since exited.
 *
 * Subagents DO write heartbeats while running (the projector stamps one from
 * their tool events, carrying `kind: "subagent"` + `session_id` = the parent's
 * instance_id), so for a *live* subagent the parent is also resolvable straight
 * off the heartbeat. See `resolveSubagentLinkage` in agent-summary.ts, which
 * the live summary layer uses so a running subagent's `↳parent` resolves at
 * spawn instead of at exit. This durable-log path remains the source for ended
 * subagents (heartbeat already unlinked) and for the durable identity fields
 * (agent_type) the heartbeat doesn't carry.
 */
export function readInstanceIdentities(): Record<string, InstanceIdentity> {
  identityIndexCache = refreshIdentityIndex(coordRoot(), identityIndexCache);
  return identityIndexCache.identities;
}

export type CouncilStatus = "active" | "closed" | "archived";
export type CouncilRoundStatus = "open" | "collected";

export interface CouncilManifestRaw {
  schema_version: number;
  council_id: string;
  objective: string;
  status: CouncilStatus;
  created_at: string;
  created_by: string;
  created_by_id?: string;
  steward?: string;
  steward_id?: string;
  members: string[];
  member_ids: string[];
  current_round: number;
  round_status: CouncilRoundStatus;
  round_visibility?: "next_round" | "live";
  auto_advance?: boolean;
  target_doc?: string | null;
  closed_at?: string | null;
  archived_at?: string | null;
}

export interface CouncilSummary extends CouncilManifestRaw {
  contributors_in_current_round: string[];
  pending_in_current_round: string[];
  total_contributions: number;
  close_handoff_path: string | null;
  duration_label: string | null;
}

function listCouncilManifests(): {
  manifests: CouncilManifestRaw[];
  invalid: InvalidHeartbeat[];
} {
  const cd = councilsDir();
  const invalid: InvalidHeartbeat[] = [];
  const out: CouncilManifestRaw[] = [];
  if (!existsSync(cd)) return { manifests: out, invalid };
  let entries: string[] = [];
  try {
    entries = readdirSync(cd);
  } catch (err) {
    invalid.push({ file: cd, issue: `councils dir read failed: ${(err as Error).message}` });
    return { manifests: out, invalid };
  }
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(cd, f);
    try {
      const parsed = JSON.parse(readFileSync(full, "utf-8")) as CouncilManifestRaw;
      out.push(parsed);
    } catch (err) {
      invalid.push({ file: f, issue: `parse error: ${(err as Error).message}` });
    }
  }
  return { manifests: out, invalid };
}

export interface CouncilsSnapshot {
  active: CouncilSummary[];
  closed: CouncilSummary[];
  archived: CouncilSummary[];
  meta: {
    scanned_dir: string;
    count: number;
    invalid: InvalidHeartbeat[];
  };
}

function contributorIdsInRound(councilId: string, round: number, archived: boolean): string[] {
  const base = archived ? path.join(councilsDir(), "archive") : councilsDir();
  const rd = path.join(base, councilId, `round-${round}`);
  if (!existsSync(rd)) return [];
  try {
    return readdirSync(rd)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3));
  } catch {
    return [];
  }
}

function contributorsInRound(
  manifest: CouncilManifestRaw,
  round: number,
  archived: boolean,
): string[] {
  const ids = contributorIdsInRound(manifest.council_id, round, archived);
  const idToName = new Map<string, string>();
  for (let i = 0; i < (manifest.member_ids ?? []).length; i++) {
    const id = manifest.member_ids[i];
    const name = manifest.members[i];
    if (id && name) idToName.set(id, name);
  }
  return ids.map((id) => idToName.get(id) ?? `agent-${id.slice(0, 8)}`).sort();
}

function countContributionsAcrossRounds(
  councilId: string,
  upToRound: number,
  archived: boolean,
): number {
  const base = archived ? path.join(councilsDir(), "archive") : councilsDir();
  let total = 0;
  for (let r = 1; r <= upToRound; r++) {
    const rd = path.join(base, councilId, `round-${r}`);
    if (!existsSync(rd)) continue;
    try {
      for (const f of readdirSync(rd)) {
        if (f.endsWith(".md")) total++;
      }
    } catch {
      /* skip */
    }
  }
  return total;
}

/**
 * Find the close-out handoff doc by scanning docs/handoffs/<bucket>/*.md
 * for any file whose body cites this council_id. Only called for
 * closed/archived councils; active rows skip the scan.
 */
function findCloseHandoffDoc(councilId: string): string | null {
  const handoffsDir = path.join(coordRoot(), "docs", "handoffs");
  if (!existsSync(handoffsDir)) return null;
  let buckets: string[];
  try {
    buckets = readdirSync(handoffsDir);
  } catch {
    return null;
  }
  for (const bucket of buckets) {
    const bucketPath = path.join(handoffsDir, bucket);
    try {
      if (!statSync(bucketPath).isDirectory()) continue;
    } catch {
      continue;
    }
    let files: string[];
    try {
      files = readdirSync(bucketPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      const fp = path.join(bucketPath, file);
      try {
        const body = readFileSync(fp, "utf-8");
        if (body.includes(councilId)) {
          return path.relative(coordRoot(), fp);
        }
      } catch {
        /* skip */
      }
    }
  }
  return null;
}

function enrich(m: CouncilManifestRaw, archived: boolean): CouncilSummary {
  const round = m.current_round ?? 1;
  const contributors = contributorsInRound(m, round, archived);
  const pending = (m.members ?? []).filter((mem) => !contributors.includes(mem));
  const total = countContributionsAcrossRounds(m.council_id, round, archived);
  const isTerminal = m.status !== "active";
  const handoff = isTerminal ? findCloseHandoffDoc(m.council_id) : null;
  const endIso = m.archived_at ?? m.closed_at;
  const duration = isTerminal && endIso ? formatDuration(m.created_at, endIso) : null;
  return {
    ...m,
    contributors_in_current_round: contributors,
    pending_in_current_round: pending,
    total_contributions: total,
    close_handoff_path: handoff,
    duration_label: duration,
  };
}

export function readCouncils(): CouncilsSnapshot {
  const cd = councilsDir();
  const { manifests, invalid } = listCouncilManifests();
  const archiveDir = path.join(cd, "archive");
  const archived: CouncilManifestRaw[] = [];
  if (existsSync(archiveDir)) {
    try {
      for (const f of readdirSync(archiveDir)) {
        if (!f.endsWith(".json")) continue;
        try {
          archived.push(
            JSON.parse(readFileSync(path.join(archiveDir, f), "utf-8")) as CouncilManifestRaw,
          );
        } catch (err) {
          invalid.push({ file: f, issue: `archive parse error: ${(err as Error).message}` });
        }
      }
    } catch (err) {
      invalid.push({ file: archiveDir, issue: `archive read failed: ${(err as Error).message}` });
    }
  }
  // Newest first
  const sortDesc = (a: CouncilManifestRaw, b: CouncilManifestRaw) =>
    b.created_at.localeCompare(a.created_at);
  return {
    active: manifests
      .filter((m) => m.status === "active")
      .sort(sortDesc)
      .map((m) => enrich(m, false)),
    closed: manifests
      .filter((m) => m.status === "closed")
      .sort(sortDesc)
      .map((m) => enrich(m, false)),
    archived: archived.sort(sortDesc).map((m) => enrich(m, true)),
    meta: {
      scanned_dir: cd,
      count: manifests.length + archived.length,
      invalid,
    },
  };
}

export interface CouncilRoundContributor {
  /** Display name (`agent-<Name>`) resolved via the identity registry. */
  author: string;
  /** Legacy alias for `author`, kept for the existing simple Rounds list. */
  agent: string;
  bytes: number;
  body: string;
}

export interface CouncilRoundView {
  round: number;
  contributors: CouncilRoundContributor[];
  /** Largest >5 KB contribution body: the round's plan-doc snapshot. */
  canonical_snapshot: CouncilRoundContributor | null;
}

export type CouncilPromptState = "contributed" | "active" | "queued";

export interface CouncilPromptView {
  member: string;
  body: string;
  bytes: number;
  completed: boolean;
  order: number;
  state: CouncilPromptState;
}

export interface CouncilDetail {
  manifest: CouncilManifestRaw;
  summary: CouncilSummary;
  invite_markdown: string | null;
  /** Effective steward: `manifest.steward || manifest.created_by`, with
   * the `agent-` prefix normalized. */
  steward: string;
  /** Visible rounds: for `next_round` visibility, only rounds < current_round
   * are populated; for `live`, every round is included. */
  rounds: CouncilRoundView[];
  /** Display-name contributors in the current round (used by the Round-N card). */
  current_round_contributors: string[];
  /** Per-member routing prompts drafted for the current round. */
  current_round_prompts: CouncilPromptView[];
  contribution_matrix: ContributionMatrix;
  consecutive_all_trivial_rounds: number;
  exit_criterion_met: boolean;
  archived: boolean;
}

/** Min bytes a contribution body must reach to count as a "snapshot". The
 * RoundDiff component walks only these. Shorter contributions are status
 * messages, not plan-doc edits. Mirrors the host CLI's value. */
export const SNAPSHOT_MIN_BYTES = 5_000;

const EXIT_CRITERION_MIN_CONSECUTIVE_TRIVIAL_ROUNDS = 2;

export function readCouncilDetail(councilId: string, archivedHint = false): CouncilDetail | null {
  const cd = councilsDir();
  const activePath = path.join(cd, `${councilId}.json`);
  const archivedPath = path.join(cd, "archive", `${councilId}.json`);

  let mp: string;
  let archived: boolean;
  if (existsSync(activePath) && !archivedHint) {
    mp = activePath;
    archived = false;
  } else if (existsSync(archivedPath)) {
    mp = archivedPath;
    archived = true;
  } else if (existsSync(activePath)) {
    mp = activePath;
    archived = false;
  } else {
    return null;
  }

  let manifest: CouncilManifestRaw;
  try {
    manifest = JSON.parse(readFileSync(mp, "utf-8")) as CouncilManifestRaw;
  } catch {
    return null;
  }

  const bodyDir = archived ? path.join(cd, "archive", councilId) : path.join(cd, councilId);
  const summary = enrich(manifest, archived);

  let invite: string | null = null;
  const invitePath = path.join(bodyDir, "invite.md");
  if (existsSync(invitePath)) {
    invite = readFileSync(invitePath, "utf-8");
  }

  // Build per-round contributor views. File names are <member_id>.md; map
  // IDs back to display names via the manifest's member_ids[] order.
  const idToName = new Map<string, string>();
  for (let i = 0; i < (manifest.member_ids ?? []).length; i++) {
    const id = manifest.member_ids[i];
    const name = manifest.members[i];
    if (id && name) idToName.set(id, name);
  }
  const memberOrder = new Map(manifest.members.map((m, i) => [m, i]));

  const rounds: CouncilRoundView[] = [];
  if (existsSync(bodyDir)) {
    for (const entry of readdirSync(bodyDir).sort()) {
      const match = /^round-(\d+)$/.exec(entry);
      if (!match) continue;
      const roundNum = Number(match[1]);
      const roundDir = path.join(bodyDir, entry);
      const contribs: CouncilRoundContributor[] = [];
      try {
        for (const f of readdirSync(roundDir)) {
          if (!f.endsWith(".md")) continue;
          if (f.startsWith("prompt-")) continue;
          const fp = path.join(roundDir, f);
          const id = f.slice(0, -3);
          const author = idToName.get(id) ?? `agent-${id.slice(0, 8)}`;
          let body = "";
          let bytes = 0;
          try {
            body = readFileSync(fp, "utf-8");
            bytes = statSync(fp).size;
          } catch {
            /* skip */
          }
          contribs.push({ author, agent: author, bytes, body });
        }
      } catch {
        // skip unreadable round
      }
      // Walk in manifest.members order; non-member entries fall to end.
      contribs.sort((a, b) => {
        const ai = memberOrder.get(a.author) ?? Number.MAX_SAFE_INTEGER;
        const bi = memberOrder.get(b.author) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.author.localeCompare(b.author);
      });
      // Canonical snapshot = the largest >5KB contribution. Others are
      // status messages or empty signoffs.
      let canonical: CouncilRoundContributor | null = null;
      for (const c of contribs) {
        if (c.bytes < SNAPSHOT_MIN_BYTES) continue;
        if (!canonical || c.bytes > canonical.bytes) canonical = c;
      }
      rounds.push({ round: roundNum, contributors: contribs, canonical_snapshot: canonical });
    }
  }

  // Per-member routing prompts for the current round live under
  // round-<n>/prompts/<member_id>.md. Walks manifest.member_ids in order
  // (matching the council's round-robin sequence). The first not-yet-
  // contributed entry is promoted to `active`; the rest are `queued`.
  const currentRound = manifest.current_round ?? 1;
  const promptsDir = path.join(bodyDir, `round-${currentRound}`, "prompts");
  const contributorIds = new Set<string>();
  const currentRoundDir = path.join(bodyDir, `round-${currentRound}`);
  if (existsSync(currentRoundDir)) {
    try {
      for (const f of readdirSync(currentRoundDir)) {
        if (f.endsWith(".md") && !f.startsWith("prompt-")) {
          contributorIds.add(f.slice(0, -3));
        }
      }
    } catch {
      /* skip */
    }
  }
  const currentRoundPrompts: CouncilPromptView[] = [];
  if (existsSync(promptsDir)) {
    for (let i = 0; i < (manifest.member_ids ?? []).length; i++) {
      const memberId = manifest.member_ids[i];
      if (!memberId) continue;
      const member = manifest.members[i] ?? `agent-${memberId.slice(0, 8)}`;
      const fp = path.join(promptsDir, `${memberId}.md`);
      if (!existsSync(fp)) continue;
      let body = "";
      let bytes = 0;
      try {
        body = readFileSync(fp, "utf-8");
        bytes = statSync(fp).size;
      } catch {
        continue;
      }
      const completed = contributorIds.has(memberId);
      currentRoundPrompts.push({
        member,
        body,
        bytes,
        completed,
        order: currentRoundPrompts.length + 1,
        state: completed ? "contributed" : "queued",
      });
    }
    for (const row of currentRoundPrompts) {
      if (row.state !== "contributed") {
        row.state = "active";
        break;
      }
    }
  }
  // Current-round contributor names (display), surfaced separately for the
  // Round-N (N/N) card so it can list contributed/pending sets cleanly.
  const currentRoundContributors = manifest.members.filter((_, idx) => {
    const id = manifest.member_ids?.[idx];
    return id ? contributorIds.has(id) : false;
  });

  // Read target_doc for the contribution matrix.
  let targetDocBody: string | null = null;
  if (manifest.target_doc) {
    const docPath = path.join(coordRoot(), manifest.target_doc);
    if (existsSync(docPath)) {
      try {
        targetDocBody = readFileSync(docPath, "utf-8");
      } catch {
        /* fall through */
      }
    }
  }
  const contribution_matrix = buildContributionMatrix(
    manifest.members ?? [],
    manifest.current_round ?? 1,
    targetDocBody,
  );
  // Two sources for round triviality, take the stronger signal:
  //   1. the target doc's changelog table (matrix), only maintained by
  //      councils that keep members + changelog tables in the doc;
  //   2. the `<trivial>`/`<substantive>` status markers in the contribution
  //      bodies themselves, the contribute-convention default.
  // Collected rounds only: everything below current_round, plus the current
  // round once round_status flips to collected (an in-progress round's
  // partial set must not fire the criterion early).
  const collectedRoundBodies = rounds
    .filter(
      (r) =>
        r.round < currentRound ||
        (r.round === currentRound && manifest.round_status === "collected"),
    )
    .map((r) => ({
      round: r.round,
      bodies: r.contributors.map((c) => c.body),
    }));
  const consecutive_all_trivial_rounds = Math.max(
    countConsecutiveAllTrivialRounds(contribution_matrix),
    countConsecutiveAllTrivialRoundsFromTags(collectedRoundBodies),
  );
  // History-pure: the criterion is a property of the collected rounds and
  // must survive an operator advancing past the finish line (the stray open
  // round). Decision-point gating (collected-or-idle) lives downstream in
  // closeRecommended (page.tsx / CouncilActions / NextActionBanner).
  const exit_criterion_met =
    manifest.status === "active" &&
    consecutive_all_trivial_rounds >= EXIT_CRITERION_MIN_CONSECUTIVE_TRIVIAL_ROUNDS;

  // Effective steward: prefer manifest.steward, fall back to created_by,
  // normalize the `agent-` prefix.
  const stewardRaw = (manifest.steward || manifest.created_by || "").trim();
  const steward = stewardRaw
    ? stewardRaw.startsWith("agent-")
      ? stewardRaw
      : `agent-${stewardRaw}`
    : "";

  return {
    manifest,
    summary,
    invite_markdown: invite,
    steward,
    rounds,
    current_round_contributors: currentRoundContributors,
    current_round_prompts: currentRoundPrompts,
    contribution_matrix,
    consecutive_all_trivial_rounds,
    exit_criterion_met,
    archived,
  };
}

export { formatDuration };

export function ageLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m ago`;
  }
  return `${Math.floor(seconds / 86400)}d ago`;
}
