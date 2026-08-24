/**
 * Coord-state reader for the standalone harnery web UI.
 *
 * Resolves the `.harnery/` directory from:
 *   1. `HARNERY_COORD_ROOT` env var (set by `harn web up` to the user's cwd)
 *   2. Walk up from process.cwd() looking for a `.harnery/` directory
 *
 * Reads the V3 coordination projection, councils, events, and journals.
 * Invalid disposable cache entries are diagnostics, never authority.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { listSessionFinalizationRequestsV3 } from "../../src/core/agents/session-finalization-state-v3";
import { readLiveCoordinationRows } from "../../src/core/agents/state/live-coordination-view";
import type { AgentActivity, TaskState } from "../../src/core/agents/state/session-state";
import type { EventV3 } from "../../src/core/events/v3/contract";
import { readEventV3ControlState } from "../../src/core/events/v3/control";
import {
  type CoordinationGenerationViewV3,
  projectCoordinationViewV3,
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../../src/core/events/v3/coordination-view";
import { type LiveDisplayRowV3, listLiveDisplayV3 } from "../../src/core/events/v3/live-feed";
import {
  liveInstanceIdV3,
  nativeInstanceIdV3,
  observeLiveEventLedgerRouteV3,
} from "../../src/core/events/v3/live-route-observer";
import { listHookProducerStateSummariesV3 } from "../../src/core/events/v3/producers/producer-state-observer";
import { eventV3Paths, readLedgerV3 } from "../../src/core/events/v3/reader";
import {
  buildContributionMatrix,
  type ContributionMatrix,
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

export function journalDir(): string {
  return path.join(harneryDir(), "journal");
}

export function eventsPath(): string {
  return eventV3Paths(coordRoot()).active;
}

export interface Heartbeat {
  instance_id: string;
  /**
   * The canonical `inst_*` id for this generation, when the row also has an
   * adapter-native owner id in `instance_id`. Ledger evidence is always keyed
   * canonically, so this is the join key against event-derived state.
   */
  v3_instance_id?: string;
  name: string;
  kind?: string;
  platform?: string | null;
  session_id?: string;
  started_at?: string;
  last_heartbeat: string;
  files_touched: string[];
  task?: string | null;
  task_updated_at?: string | null;
  activity: AgentActivity;
  activity_updated_at?: string | null;
  activity_source?: string | null;
  task_state: TaskState;
  task_state_updated_at?: string | null;
  task_state_reason?: string | null;
  model?: string | null;
  age_seconds: number;
  ledger_state?: AgentLedgerStateV3;
  generation_id?: string;
  open_span_count?: number;
}

export type AgentLedgerStateV3 = "live" | "ending" | "recovery-required" | "terminal";

export interface AgentLedgerRecordV3 {
  instance_id: string;
  generation_id: string;
  state: AgentLedgerStateV3;
  open_span_count: number;
  generation: CoordinationGenerationViewV3;
}

export interface InvalidHeartbeat {
  file: string;
  issue: string;
}

/**
 * Why the row list is empty. `readLiveCoordinationRows` answers a blocked
 * ledger route and an unsafe authority view the same way it answers a genuinely
 * idle repo — with no rows — so an empty dashboard alone cannot tell "nobody is
 * working" from "this build cannot read the ledger". Only computed when there
 * are no rows to explain.
 */
export type LedgerReadState = { ok: true } | { ok: false; reason: string };

export interface AgentsSnapshot {
  active: Heartbeat[];
  stale: Heartbeat[];
  terminal: Heartbeat[];
  claims: ClaimRow[];
  meta: {
    scanned_dir: string;
    count: number;
    invalid: InvalidHeartbeat[];
    stale_threshold_seconds: number;
    read_state: LedgerReadState;
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

function isV3CacheShape(v: unknown): v is Omit<Heartbeat, "age_seconds"> & {
  schema_version: 2;
  v3_instance_id: string;
  v3_generation_id: string;
} {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.schema_version === 2 &&
    typeof r.v3_instance_id === "string" &&
    typeof r.v3_generation_id === "string" &&
    typeof r.instance_id === "string" &&
    typeof r.last_heartbeat === "string" &&
    Array.isArray(r.files_touched)
  );
}

function readCacheDiagnostics(): { invalid: InvalidHeartbeat[]; dir: string } {
  const dir = activeDir();
  const invalid: InvalidHeartbeat[] = [];

  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch (err) {
    invalid.push({ file: dir, issue: `active dir missing: ${(err as Error).message}` });
    return { invalid, dir };
  }

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
    if (!isV3CacheShape(parsed)) {
      invalid.push({ file, issue: "not a generation-bound V3 cache" });
    }
  }
  return { invalid, dir };
}

/**
 * Reproduce the two silent bail-outs in `readLiveCoordinationRows` so an empty
 * list can name its cause. Repeats that function's reads, so call it only when
 * the list is already empty.
 */
function probeLedgerReadState(root: string): LedgerReadState {
  const route = observeLiveEventLedgerRouteV3(root);
  if (route.state === "blocked") {
    return { ok: false, reason: `ledger route blocked: ${route.reason}` };
  }
  try {
    requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(root));
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  return { ok: true };
}

export function readAgents(): AgentsSnapshot {
  const root = coordRoot();
  const { invalid, dir } = readCacheDiagnostics();
  const ledgerRecords = readAgentLedgerRecordsV3();
  const now = Date.now();
  const all: Heartbeat[] = readLiveCoordinationRows(root).map((row) => {
    const ts = Date.parse(row.last_heartbeat);
    return {
      ...row,
      name: row.name ?? row.instance_id,
      activity: row.activity ?? "unknown",
      task_state: row.task_state ?? "active",
      age_seconds: Number.isFinite(ts) ? Math.max(0, Math.floor((now - ts) / 1_000)) : 0,
    };
  });
  const represented = new Set<string>();
  for (const heartbeat of all) {
    const canonicalId = liveInstanceIdV3(heartbeat.instance_id);
    const record = ledgerRecords.get(heartbeat.instance_id) ?? ledgerRecords.get(canonicalId);
    if (!record) continue;
    represented.add(record.instance_id);
    heartbeat.ledger_state = record.state;
    heartbeat.generation_id = record.generation_id;
    heartbeat.open_span_count = record.open_span_count;
  }
  for (const record of ledgerRecords.values()) {
    if (record.state === "terminal" || represented.has(record.instance_id)) continue;
    all.push(heartbeatFromLedgerRecord(record));
  }
  all.sort((a, b) => b.last_heartbeat.localeCompare(a.last_heartbeat));

  const active = all.filter((h) => h.age_seconds < STALE_AGE_SECONDS);
  const stale = all.filter((h) => h.age_seconds >= STALE_AGE_SECONDS);
  const terminal = [...ledgerRecords.values()]
    .filter((record) => record.state === "terminal" && !represented.has(record.instance_id))
    .map(heartbeatFromLedgerRecord)
    .sort((a, b) => b.last_heartbeat.localeCompare(a.last_heartbeat));

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
    terminal,
    claims,
    meta: {
      scanned_dir: dir,
      count: all.length,
      invalid,
      stale_threshold_seconds: STALE_AGE_SECONDS,
      read_state: all.length === 0 ? probeLedgerReadState(root) : { ok: true },
    },
  };
}

export function readAgent(instanceId: string): Heartbeat | null {
  const snapshot = readAgents();
  return (
    [...snapshot.active, ...snapshot.stale].find(
      (heartbeat) =>
        heartbeat.instance_id === instanceId ||
        liveInstanceIdV3(heartbeat.instance_id) === instanceId,
    ) ?? null
  );
}

/**
 * Reconstruct a read-only coordination row for an agent whose live V3 generation is gone
 * (session ended, or the file was pruned) but whose durable identity persists in
 * the append-only event log. Mirrors what `buildEndedAgentSummaries` does for the
 * hover card, so the standalone `/agents/[id]` page works for ended agents too
 * instead of 404ing.
 *
 * Only the fields that survive a session are populated: name / platform /
 * session_id / started_at from the canonical `session.started` record,
 * and `last_heartbeat` set to the agent's most-recent event ts (a real "last
 * seen", more accurate than the start ts). The live-only fields (task,
 * files_touched and model) are intentionally empty: they
 * lived in the heartbeat and don't outlast it. Callers distinguish this from a
 * live V3 generation by checking `readAgent` first and gate live-only mutation
 * actions (heal / kill / nudge / end-session) on that.
 *
 * Returns null when no identity exists for the instance (→ genuine notFound).
 */
export function readEndedAgent(instanceId: string): Heartbeat | null {
  const records = readAgentLedgerRecordsV3();
  const terminal = records.get(instanceId) ?? records.get(liveInstanceIdV3(instanceId));
  if (terminal?.state === "terminal") return heartbeatFromLedgerRecord(terminal);
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
    activity: identity.activity ?? "unknown",
    activity_updated_at: identity.activity_updated_at ?? null,
    activity_source: identity.activity_source ?? null,
    task_state: identity.task_state ?? "active",
    task_state_updated_at: identity.task_state_updated_at ?? null,
    task_state_reason: identity.task_state_reason ?? null,
    model: null,
    age_seconds: ageSec,
  };
}

export function classifyAgentLedgerStateV3(input: {
  terminal: boolean;
  pending_finalization: boolean;
  open_span_count: number;
  turn_open: boolean;
}): AgentLedgerStateV3 {
  if (input.terminal) return "terminal";
  if (input.pending_finalization) return "ending";
  if (input.open_span_count > 0 && !input.turn_open) return "recovery-required";
  return "live";
}

function readAgentLedgerRecordsV3(): Map<string, AgentLedgerRecordV3> {
  const root = coordRoot();
  const control = readEventV3ControlState(root);
  if (control.state !== "candidate" && control.state !== "active") return new Map();
  try {
    const read = readLedgerV3(root);
    if (!read.complete) return new Map();
    const view = projectCoordinationViewV3(read);
    const pending = new Set<string>(
      listSessionFinalizationRequestsV3(root)
        .filter((request) => request.status === "pending")
        .map((request) => request.generation_id),
    );
    const openSpans = new Map<string, { count: number; turn_open: boolean }>();
    for (const state of listHookProducerStateSummariesV3(root)) {
      if (state.open_span_count === 0) continue;
      openSpans.set(state.generation_id, {
        count: state.open_span_count,
        turn_open: state.turn_open,
      });
    }
    const records = new Map<string, AgentLedgerRecordV3>();
    for (const generation of [
      ...Object.values(view.instances),
      ...Object.values(view.terminal_generations),
    ]) {
      const spans = openSpans.get(generation.generation_id) ?? { count: 0, turn_open: false };
      const record: AgentLedgerRecordV3 = {
        instance_id: generation.instance_id,
        generation_id: generation.generation_id,
        state: classifyAgentLedgerStateV3({
          terminal: generation.phase === "terminal",
          pending_finalization: pending.has(generation.generation_id),
          open_span_count: spans.count,
          turn_open: spans.turn_open,
        }),
        open_span_count: spans.count,
        generation,
      };
      const current = records.get(generation.instance_id);
      if (!current || current.generation.last_observed_at < generation.last_observed_at) {
        records.set(generation.instance_id, record);
      }
    }
    return records;
  } catch {
    return new Map();
  }
}

function heartbeatFromLedgerRecord(record: AgentLedgerRecordV3): Heartbeat {
  const generation = record.generation;
  const observedAt = generation.last_observed_at;
  const observedMs = Date.parse(observedAt);
  const adapter = generation.runtime_attestation.adapter;
  const model = generation.runtime_attestation.model;
  return {
    instance_id: generation.instance_id,
    name: nameForLedgerInstance(generation.instance_id),
    kind: generation.parent_generation_id ? "subagent" : "session",
    platform: adapter.state === "observed" ? adapter.value.id : null,
    session_id: generation.session_id,
    started_at: generation.started_at,
    last_heartbeat: observedAt,
    files_touched: generation.files_touched,
    task: null,
    activity: generation.activity === "terminal" ? "idle" : generation.activity,
    activity_updated_at: observedAt,
    activity_source: "event-v3-coordination-view",
    task_state: normalizeTaskState(generation.task_state),
    task_state_updated_at: observedAt,
    task_state_reason: null,
    model: model.state === "observed" ? model.value.id : null,
    age_seconds: Number.isFinite(observedMs)
      ? Math.max(0, Math.floor((Date.now() - observedMs) / 1000))
      : 0,
    ledger_state: record.state,
    generation_id: generation.generation_id,
    open_span_count: record.open_span_count,
  };
}

function nameForLedgerInstance(instanceId: string): string {
  const historyPath = path.join(harneryDir(), ".name-history");
  if (existsSync(historyPath)) {
    for (const line of readFileSync(historyPath, "utf8").split("\n").reverse()) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { instance_id?: string; name?: string };
        if (
          entry.name &&
          entry.instance_id &&
          (entry.instance_id === instanceId || liveInstanceIdV3(entry.instance_id) === instanceId)
        ) {
          return entry.name.startsWith("agent-") ? entry.name.slice("agent-".length) : entry.name;
        }
      } catch {
        // Ignore malformed history rows; the instance prefix remains an honest fallback.
      }
    }
  }
  return nativeInstanceIdV3(instanceId).slice(0, 8);
}

function normalizeTaskState(value: string | undefined): TaskState {
  return value === "blocked" || value === "done" ? value : "active";
}

export interface JournalEntry {
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

export interface JournalDoc {
  exists: boolean;
  path: string;
  bytes: number;
  entries: JournalEntry[];
}

// Journal entries look like: `## 2026-05-27 10:39 AM CDT · handoff`
// (see src/core/journal/index.ts; appendEntry emits this format).
const JOURNAL_HEADER_RE =
  /^##\s+(?<ts>.+?)\s+·\s+(?<cat>note|plan|decision|blocker|question|done|handoff)\s*$/i;

export function readJournal(instanceId: string): JournalDoc {
  const p = path.join(journalDir(), `${instanceId}.md`);
  if (!existsSync(p)) {
    return { exists: false, path: p, bytes: 0, entries: [] };
  }
  const text = readFileSync(p, "utf-8");
  const bytes = Buffer.byteLength(text, "utf-8");
  const entries: JournalEntry[] = [];
  const lines = text.split("\n");
  let current: JournalEntry | null = null;
  const bodyBuf: string[] = [];
  for (const line of lines) {
    const m = JOURNAL_HEADER_RE.exec(line);
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

export interface JournalArchive {
  filename: string;
  path: string;
  bytes: number;
  archived_at: string;
  is_pre_ui_edit: boolean;
}

/**
 * List archived journals for one owner. Archive filenames follow two
 * shapes from `harnery/src/core/journal/index.ts`:
 *
 *   <owner>-<iso>.md            auto-archive on SessionEnd
 *   <owner>-pre-ui-<iso>.md     pre-edit snapshot from the web UI's wholesale Replace
 *
 * Both use `2026-05-28T14-06-19-123Z` style ISO with `:` swapped to `-` for
 * filesystem safety; we revert that to a real ISO for `archived_at`.
 */
export function listJournalArchives(instanceId: string): JournalArchive[] {
  const dir = path.join(journalDir(), "archived");
  if (!existsSync(dir)) return [];
  const prefix = `${instanceId}-`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: JournalArchive[] = [];
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

export function readJournalArchive(instanceId: string, filename: string): string | null {
  // Tight whitelist: must start with the owner prefix and end in `.md`, no slashes.
  if (
    !filename.startsWith(`${instanceId}-`) ||
    !filename.endsWith(".md") ||
    filename.includes("/") ||
    filename.includes("..")
  ) {
    return null;
  }
  const p = path.join(journalDir(), "archived", filename);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

type EventRowForV3<E extends EventV3> = {
  schema_version: 3;
  event_id: E["event_id"];
  event_type: E["event_type"];
  ts: string;
  instance_id?: string;
  session_id?: string;
  adapter?: string;
  source?: string;
  data: E["payload"];
  live_display?: Pick<LiveDisplayRowV3, "executable" | "intent_display" | "target_labels">;
};

/** Discriminated, privacy-safe web DTO projected only from validated V3 rows. */
export type EventRow = EventV3 extends infer E
  ? E extends EventV3
    ? EventRowForV3<E>
    : never
  : never;

export interface EventsResponse {
  rows: EventRow[];
  meta: {
    path: string;
    total_lines: number;
    returned: number;
  };
}

export function readEvents(
  opts: {
    limit?: number;
    instanceId?: string;
    type?: string;
    /** Session-id allowlist. A main adapter session carries the same id in
     * `session_id` and `instance_id`, so either matching is a hit. */
    sessions?: Set<string>;
    /** Read another checkout's V3 ledger. */
    root?: string;
  } = {},
): EventsResponse {
  const root = opts.root ?? coordRoot();
  const control = readEventV3ControlState(root);
  if (control.state === "candidate" || control.state === "active") {
    const catalogPath = path.join(root, ".harnery", "ledgers", "v3", "catalog.json");
    const ledger = readLedgerV3(root);
    const liveDisplay = new Map(listLiveDisplayV3(root).map((row) => [row.event_id, row]));
    const rows: EventRow[] = [];
    if (ledger.complete) {
      for (
        let index = ledger.events.length - 1;
        index >= 0 && rows.length < (opts.limit ?? 200);
        index--
      ) {
        const event = ledger.events[index]!.event;
        const display = liveDisplay.get(event.event_id);
        const row = {
          schema_version: 3,
          event_id: event.event_id,
          event_type: event.event_type,
          ts: event.time.recorded_at,
          instance_id: event.scope.instance_id,
          session_id: "session_id" in event.scope ? event.scope.session_id : undefined,
          source: event.provenance.source_event,
          data: event.payload,
          ...(display
            ? {
                live_display: {
                  ...(display.executable ? { executable: display.executable } : {}),
                  ...(display.intent_display ? { intent_display: display.intent_display } : {}),
                  ...(display.target_labels ? { target_labels: display.target_labels } : {}),
                },
              }
            : {}),
        } as EventRow;
        if (opts.instanceId && row.instance_id !== opts.instanceId) continue;
        if (opts.type && row.event_type !== opts.type) continue;
        if (
          opts.sessions &&
          !(
            (row.session_id !== undefined && opts.sessions.has(row.session_id)) ||
            (row.instance_id !== undefined && opts.sessions.has(row.instance_id))
          )
        ) {
          continue;
        }
        rows.push(row);
      }
    }
    return {
      rows,
      meta: {
        path: existsSync(catalogPath)
          ? catalogPath
          : path.join(root, ".harnery", "ledgers", "v3", "active.ndjson"),
        total_lines: ledger.events.length,
        returned: rows.length,
      },
    };
  }
  return {
    rows: [],
    meta: {
      path: path.join(root, ".harnery", "ledgers", "v3"),
      total_lines: 0,
      returned: 0,
    },
  };
}

/** Durable instance identity projected exclusively from V3 plus name history. */
export interface InstanceIdentity {
  instance_id: string;
  name: string;
  agent_id?: string | null;
  kind: "session" | "subagent";
  agent_type?: string | null;
  session_id?: string | null;
  platform?: string | null;
  model?: string | null;
  activity?: AgentActivity;
  activity_updated_at?: string | null;
  activity_source?: string | null;
  task_state?: TaskState;
  task_state_updated_at?: string | null;
  task_state_reason?: string | null;
  started_at?: string | null;
  last_ts?: string | null;
}

export function __resetIdentityIndexCache(): void {
  // V3 projection is rebuilt from the canonical reader on demand.
}

export function readInstanceIdentities(): Record<string, InstanceIdentity> {
  const root = coordRoot();
  const control = readEventV3ControlState(root);
  if (control.state !== "candidate" && control.state !== "active") return {};
  const ledger = readLedgerV3(root);
  if (!ledger.complete) return {};
  const view = projectCoordinationViewV3(ledger);
  const generations = [
    ...Object.values(view.instances),
    ...Object.values(view.terminal_generations),
  ];
  const identities: Record<string, InstanceIdentity> = {};
  for (const generation of generations) {
    identities[generation.instance_id] = {
      instance_id: generation.instance_id,
      name: nameForLedgerInstance(generation.instance_id),
      agent_id: generation.identity_id ?? null,
      kind: generation.parent_generation_id ? "subagent" : "session",
      agent_type: generation.delegation_role ?? null,
      session_id: generation.session_id,
      platform:
        generation.runtime_attestation.adapter.state === "observed"
          ? generation.runtime_attestation.adapter.value.id
          : null,
      model:
        generation.runtime_attestation.model.state === "observed"
          ? generation.runtime_attestation.model.value.id
          : null,
      activity: generation.activity === "terminal" ? "idle" : generation.activity,
      activity_updated_at: generation.last_observed_at,
      activity_source: "event-v3-coordination-view",
      task_state: normalizeTaskState(generation.task_state),
      task_state_updated_at: generation.last_observed_at,
      task_state_reason: null,
      started_at: generation.started_at,
      last_ts: generation.last_observed_at,
    };
  }
  return identities;
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
