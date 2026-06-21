/**
 * Council manifest helpers: file-based multi-agent coordination primitives.
 *
 * Lives under .harnery/councils/ alongside heartbeats + scratchpads. Council
 * lifecycle commands serialize manifest mutations through a shared flock;
 * round contribution files are per-member and don't need shared locking.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";

import { monorepoRoot } from "../../core/agents/index.ts";
import { resolveBinName } from "../../core/config.ts";
import { ensureIdentity, lookupById as lookupIdentityById } from "../identities/index.js";

export const COUNCIL_SCHEMA_VERSION = 2 as const;

export type CouncilStatus = "active" | "closed" | "archived";
export type CouncilRoundStatus = "open" | "collected";
export type CouncilRoundVisibility = "next_round" | "live";

export interface CouncilManifest {
  schema_version: typeof COUNCIL_SCHEMA_VERSION;
  council_id: string;
  created_at: string;
  /** Display name of the convener (denormalized, for human scan).
   * Canonical FK is `created_by_id`. */
  created_by: string;
  /** Durable persona UUID of the convener (registry key). Authoritative. */
  created_by_id: string;
  /**
   * Optional ongoing process-tender. Distinct from `created_by`, which is the
   * one-time act of creation; the steward is whoever drafts + maintains the
   * per-round prompts that route operator → contributor each round. Defaults
   * to `created_by` when omitted (set at create-time via --steward, or
   * retrofitted via direct manifest edit). Read by `agents council prompt`
   * to enforce write authority.
   *
   * Display name (denormalized). Canonical FK is `steward_id`.
   */
  steward?: string;
  /** Durable persona UUID of the steward. */
  steward_id?: string;
  objective: string;
  target_doc: string | null;
  /** Member display names (denormalized, parallel to `member_ids`). */
  members: string[];
  /** Canonical FK array of durable persona UUIDs of every member, parallel
   * to `members[]` (same length, same order). Used by contributors-in-round
   * lookups and contribution filenames (`round-N/<member_id>.md`). */
  member_ids: string[];
  current_round: number;
  round_status: CouncilRoundStatus;
  status: CouncilStatus;
  auto_advance: boolean;
  round_visibility: CouncilRoundVisibility;
  closed_at?: string;
  archived_at?: string;
}

/**
 * Resolve the effective steward: explicit `steward` field if set, otherwise
 * fall back to `created_by`. Always returns a normalized `agent-Foo` name.
 */
export function effectiveSteward(manifest: CouncilManifest): string {
  return normalizeAgentName(manifest.steward || manifest.created_by);
}

/** Resolve `.harnery/councils/` (creates the dir lazily on first write). */
export function councilsDir(): string | null {
  const root = monorepoRoot();
  if (!root) return null;
  return resolve(root, ".harnery", "councils");
}

/** Resolve `.harnery/councils/archive/`. */
export function councilsArchiveDir(): string | null {
  const cd = councilsDir();
  if (!cd) return null;
  return resolve(cd, "archive");
}

/** Manifest file path: `.harnery/councils/<id>.json`. */
export function manifestPath(councilId: string): string | null {
  const cd = councilsDir();
  if (!cd) return null;
  return resolve(cd, `${councilId}.json`);
}

/** Council body dir: `.harnery/councils/<id>/` (holds invite.md + round-N/...). */
export function councilBodyDir(councilId: string): string | null {
  const cd = councilsDir();
  if (!cd) return null;
  return resolve(cd, councilId);
}

/** Normalize an `agent-Foo`/`Foo` reference to canonical `agent-Foo` form. */
export function normalizeAgentName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("agent-") ? trimmed : `agent-${trimmed}`;
}

/** Strip the `agent-` prefix for output to lookups that expect bare name. */
export function bareAgentName(raw: string): string {
  return raw.startsWith("agent-") ? raw.slice("agent-".length) : raw;
}

/**
 * Derive a kebab-case slug from objective text. Keeps the first 5 words after
 * lowercasing and stripping non-alphanumeric chars.
 */
export function deriveSlug(objective: string): string {
  const cleaned = objective
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "council";
}

/**
 * Build a council_id from objective + today's UTC date.
 *
 * Format: `<slug>-<YYYY-MM-DD>-<4hex>`. The 4-hex suffix is sourced from a
 * crypto-strong random byte (not from a hash of the objective) to avoid
 * collisions when two councils share the same slug + date.
 */
export function buildCouncilId(objective: string, now: Date = new Date()): string {
  const slug = deriveSlug(objective);
  const date = now.toISOString().slice(0, 10);
  const hash = randomBytes(2).toString("hex");
  return `${slug}-${date}-${hash}`;
}

/** Hash an objective deterministically, used by tests for stable IDs. */
export function deterministicCouncilId(objective: string, now: Date = new Date()): string {
  const slug = deriveSlug(objective);
  const date = now.toISOString().slice(0, 10);
  const hash = createHash("sha256").update(`${objective}|${date}`).digest("hex").slice(0, 4);
  return `${slug}-${date}-${hash}`;
}

/** Atomically write a manifest (write tmp → rename). */
export function writeManifest(manifest: CouncilManifest): void {
  const mp = manifestPath(manifest.council_id);
  if (!mp) throw new Error("not in an agent session; no monorepo root");
  const cd = councilsDir();
  if (cd && !existsSync(cd)) mkdirSync(cd, { recursive: true });
  const tmp = `${mp}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmp, mp);
}

/** Read a manifest by id. Returns null when the file is missing. */
export function readManifest(councilId: string): CouncilManifest | null {
  const mp = manifestPath(councilId);
  if (!mp || !existsSync(mp)) return null;
  try {
    const parsed = JSON.parse(readFileSync(mp, "utf8")) as CouncilManifest;
    if (parsed.schema_version !== COUNCIL_SCHEMA_VERSION) {
      throw new Error(
        `council ${councilId}: unsupported schema_version=${parsed.schema_version} (expected ${COUNCIL_SCHEMA_VERSION})`,
      );
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `failed to read council manifest ${councilId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read an archived manifest by id from `.harnery/councils/archive/<id>.json`.
 * Symmetric to readManifest() but scoped to the archive dir, used by
 * `agents council unarchive` to load an archived council that is
 * (by definition) not in the active councils dir. */
export function readArchivedManifest(councilId: string): CouncilManifest | null {
  const archive = councilsArchiveDir();
  if (!archive) return null;
  const mp = resolve(archive, `${councilId}.json`);
  if (!existsSync(mp)) return null;
  try {
    const parsed = JSON.parse(readFileSync(mp, "utf8")) as CouncilManifest;
    if (parsed.schema_version !== COUNCIL_SCHEMA_VERSION) {
      throw new Error(
        `council ${councilId}: unsupported schema_version=${parsed.schema_version} (expected ${COUNCIL_SCHEMA_VERSION})`,
      );
    }
    return parsed;
  } catch (err) {
    throw new Error(
      `failed to read archived council manifest ${councilId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Reassign the steward on an active or closed council. Atomic via
 * writeManifest's tmp+rename. Refuses to mutate archived councils
 * (those are read-only by convention). Pass `null` to clear the field
 * and revert to the default (the convener, via effectiveSteward).
 */
export function setCouncilSteward(councilId: string, steward: string | null): CouncilManifest {
  const manifest = readManifest(councilId);
  if (!manifest) {
    throw new Error(`no council matching '${councilId}' in .harnery/councils/`);
  }
  if (manifest.status === "archived") {
    throw new Error(
      `council ${manifest.council_id} is archived (read-only); cannot reassign steward`,
    );
  }
  let next: CouncilManifest;
  if (steward === null) {
    const { steward: _ds, steward_id: _di, ...rest } = manifest;
    void _ds;
    void _di;
    next = rest as CouncilManifest;
  } else {
    const identity = ensureIdentity(steward);
    next = { ...manifest, steward, steward_id: identity.agent_id };
  }
  writeManifest(next);
  return next;
}

export interface KnownAgent {
  /** `agent-<Name>` canonical handle. */
  name: string;
  /** `active` = currently has a heartbeat in `.harnery/active/`. `stale` =
   * recently ended (scratchpad archived within the lookback window). */
  state: "active" | "stale";
  /** ISO timestamp of the most-recent signal. */
  last_seen: string;
}

/** Default lookback for "recently stale" agents, kept in sync with the
 * next-app's same-named constant. */
const KNOWN_AGENT_STALE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Active heartbeats + recently-archived scratchpads, deduped by name.
 * Used by `agents council set-steward` to refuse arbitrary names;
 * pass `--allow-unknown` to bypass when bootstrapping a new agent.
 */
export function listKnownAgents(): KnownAgent[] {
  const root = monorepoRoot();
  if (!root) return [];
  const activeDir = resolve(root, ".harnery", "active");
  const archiveDir = resolve(root, ".harnery", "scratch", "archived");
  const byName = new Map<string, KnownAgent>();

  if (existsSync(activeDir)) {
    for (const f of readdirSync(activeDir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const hb = JSON.parse(readFileSync(resolve(activeDir, f), "utf8")) as {
          name?: string;
          last_heartbeat?: string;
        };
        if (!hb.name) continue;
        const name = hb.name.startsWith("agent-") ? hb.name : `agent-${hb.name}`;
        const last_seen = hb.last_heartbeat ?? new Date().toISOString();
        const existing = byName.get(name);
        if (existing?.state !== "active") {
          byName.set(name, { name, state: "active", last_seen });
        }
      } catch {
        /* skip unreadable */
      }
    }
  }

  const cutoff = Date.now() - KNOWN_AGENT_STALE_WINDOW_MS;
  if (existsSync(archiveDir)) {
    const fileTimestampRe = /-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.md$/;
    for (const f of readdirSync(archiveDir)) {
      const m = f.match(fileTimestampRe);
      if (!m) continue;
      const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`;
      const ts = Date.parse(iso);
      if (Number.isNaN(ts) || ts < cutoff) continue;
      try {
        const head = readFileSync(resolve(archiveDir, f), "utf8").slice(0, 200);
        const nameMatch = head.match(/^#\s+Scratchpad:\s+(agent-[A-Za-z][A-Za-z0-9_-]*)/m);
        if (!nameMatch) continue;
        const name = nameMatch[1]!;
        const existing = byName.get(name);
        if (existing) {
          if (existing.state === "stale" && iso > existing.last_seen) {
            existing.last_seen = iso;
          }
        } else {
          byName.set(name, { name, state: "stale", last_seen: iso });
        }
      } catch {
        /* skip */
      }
    }
  }

  return Array.from(byName.values()).sort((a, b) => {
    if (a.state !== b.state) return a.state === "active" ? -1 : 1;
    return b.last_seen.localeCompare(a.last_seen);
  });
}

/** List all council manifests in the active dir (skips archive/). */
export function listManifests(): CouncilManifest[] {
  const cd = councilsDir();
  if (!cd || !existsSync(cd)) return [];
  const out: CouncilManifest[] = [];
  for (const f of readdirSync(cd)) {
    if (!f.endsWith(".json") || f === "archive") continue;
    const id = f.slice(0, -5);
    try {
      const m = readManifest(id);
      if (m) out.push(m);
    } catch {
      /* skip malformed manifests; surfaced separately if needed */
    }
  }
  return out;
}

/**
 * Move a council's manifest + body dir into the archive subdir. Idempotent:
 * archiving an already-archived council is a no-op (the source paths won't
 * exist). Used by `council archive` and by `council close --archive`.
 */
export function moveToArchive(councilId: string): void {
  const cd = councilsDir();
  const archive = councilsArchiveDir();
  if (!cd || !archive) {
    throw new Error("not in an agent session; no monorepo root");
  }
  if (!existsSync(archive)) mkdirSync(archive, { recursive: true });

  const srcManifest = resolve(cd, `${councilId}.json`);
  const dstManifest = resolve(archive, `${councilId}.json`);
  if (existsSync(srcManifest)) {
    renameSync(srcManifest, dstManifest);
  }

  const srcDir = resolve(cd, councilId);
  const dstDir = resolve(archive, councilId);
  if (existsSync(srcDir)) {
    if (existsSync(dstDir)) {
      // already archived, keep the original archive, drop the duplicate
      rmSync(srcDir, { recursive: true, force: true });
    } else {
      renameSync(srcDir, dstDir);
    }
  }
}

/**
 * Reverse of moveToArchive: move a council's manifest + body dir back from
 * archive/ to the active councils dir. Idempotent: a missing archive path is
 * a no-op; an existing active path is left untouched and the archived copy
 * is dropped (mirrors moveToArchive's clobber-avoidance rule). Used by
 * `agents council unarchive` for testing the archive flow and as an undo
 * escape hatch.
 */
export function moveFromArchive(councilId: string): void {
  const cd = councilsDir();
  const archive = councilsArchiveDir();
  if (!cd || !archive) {
    throw new Error("not in an agent session; no monorepo root");
  }

  const srcManifest = resolve(archive, `${councilId}.json`);
  const dstManifest = resolve(cd, `${councilId}.json`);
  if (existsSync(srcManifest)) {
    if (existsSync(dstManifest)) {
      // already-active manifest wins; drop the archived copy
      rmSync(srcManifest, { force: true });
    } else {
      renameSync(srcManifest, dstManifest);
    }
  }

  const srcDir = resolve(archive, councilId);
  const dstDir = resolve(cd, councilId);
  if (existsSync(srcDir)) {
    if (existsSync(dstDir)) {
      rmSync(srcDir, { recursive: true, force: true });
    } else {
      renameSync(srcDir, dstDir);
    }
  }
}

/**
 * Permanently remove an archived council: manifest + body dir under
 * .harnery/councils/archive/<id>. Refuses to touch a council that's still
 * in the active dir (caller must archive first; the trash-can pattern).
 * Idempotent: missing paths are a no-op. Returns true when something was
 * actually deleted, false when both targets were already absent.
 *
 * NB: does NOT touch the council's target_doc (separate authored artifact),
 * close_handoff_path (separate authored artifact), or the canonical event
 * stream (immutable activity log). The delete is scoped to the manifest +
 * per-round member contributions.
 */
export function deleteArchivedCouncil(councilId: string): boolean {
  const cd = councilsDir();
  const archive = councilsArchiveDir();
  if (!cd || !archive) {
    throw new Error("not in an agent session; no monorepo root");
  }
  const activeManifest = resolve(cd, `${councilId}.json`);
  if (existsSync(activeManifest)) {
    throw new Error(`council ${councilId} is not archived; archive it before delete`);
  }
  const archivedManifest = resolve(archive, `${councilId}.json`);
  const archivedBody = resolve(archive, councilId);
  let removed = false;
  if (existsSync(archivedManifest)) {
    rmSync(archivedManifest, { force: true });
    removed = true;
  }
  if (existsSync(archivedBody)) {
    rmSync(archivedBody, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

/** Resolve a member name (or partial id) to a council manifest from the active dir. */
export function findManifestByPartialId(partial: string): CouncilManifest | null {
  const cd = councilsDir();
  if (!cd || !existsSync(cd)) return null;
  for (const f of readdirSync(cd)) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    if (id === partial || id.includes(partial) || basename(f, ".json").startsWith(partial)) {
      try {
        return readManifest(id);
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Build the invite.md body that ships alongside the manifest. */
export function buildInviteMarkdown(manifest: CouncilManifest): string {
  const lines: string[] = [];
  lines.push(`# Council invitation: ${manifest.council_id}`);
  lines.push("");
  lines.push(`**Convened by:** ${manifest.created_by}`);
  lines.push(`**Created:** ${manifest.created_at}`);
  lines.push(`**Members:** ${manifest.members.join(", ")}`);
  if (manifest.target_doc) {
    lines.push(`**Target doc:** \`${manifest.target_doc}\``);
  }
  lines.push(
    `**Auto-advance:** ${manifest.auto_advance ? "yes" : "no (convener advances each round manually)"}`,
  );
  lines.push(
    `**Round visibility:** ${manifest.round_visibility} (peer contributions surface at round N+1 by default)`,
  );
  lines.push("");
  lines.push("## Objective");
  lines.push("");
  lines.push(manifest.objective);
  lines.push("");
  lines.push("## How to participate");
  lines.push("");
  const bin = resolveBinName();
  lines.push(
    `1. Read the objective + target doc (if any).\n2. Run \`${bin} agents council show ${manifest.council_id}\` for full state.\n3. Contribute your round-${manifest.current_round} take with:\n\n       ${bin} agents council contribute ${manifest.council_id} \\\n         --message "<your take>"\n       # or --file /path/to/written/feedback.md\n\n4. After all members contribute, ${manifest.created_by} (or auto-advance) opens round ${manifest.current_round + 1}.`,
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * Path to the contribution file for a member in a specific round.
 * Filename uses the agent's durable persona uuid (`<agent_id>.md`) so
 * a future rename doesn't break the link between manifest and on-disk
 * contribution. Resolves the name through the identity registry; mints a
 * new identity when the member name isn't registered yet (rare post-
 * migration; only happens for a brand-new persona that's never run).
 */
export function contributionPath(
  councilId: string,
  round: number,
  memberName: string,
): string | null {
  const body = councilBodyDir(councilId);
  if (!body) return null;
  const id = ensureIdentity(memberName).agent_id;
  return resolve(body, `round-${round}`, `${id}.md`);
}

/** Path to a round's directory: `.harnery/councils/<id>/round-<N>/`. */
export function roundDir(councilId: string, round: number): string | null {
  const body = councilBodyDir(councilId);
  if (!body) return null;
  return resolve(body, `round-${round}`);
}

/**
 * Read the set of agent-Names that have contributed to a given round.
 * Returns display names ("agent-Maya"), not raw uuids; filenames on disk
 * are now `<agent_id>.md`, so we resolve each one through the registry
 * before returning. An identity that's been pruned (or never registered)
 * surfaces as `agent-<8-char-prefix>` so the value remains scannable.
 *
 * For UUID-keyed callers, use `contributorIdsInRound`.
 * Empty array when the round directory doesn't exist yet.
 */
export function contributorsInRound(councilId: string, round: number): string[] {
  return contributorIdsInRound(councilId, round)
    .map((id) => {
      const identity = lookupIdentityById(id);
      return identity ? `agent-${identity.name}` : `agent-${id.slice(0, 8)}`;
    })
    .sort();
}

/** Like contributorsInRound but returns the raw agent_id uuids: the
 * filenames on disk without the .md extension. */
export function contributorIdsInRound(councilId: string, round: number): string[] {
  const rd = roundDir(councilId, round);
  if (!rd || !existsSync(rd)) return [];
  return readdirSync(rd)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

/**
 * Return the IDs of active councils where this agent is a member AND has not
 * yet contributed to the current open round. Used by `agents status` to
 * surface a `council N pending` line in the status box, and by SessionStart
 * adapters to inject system reminders about pending invites.
 */
export function pendingCouncilsForMember(memberName: string): string[] {
  const normalized = normalizeAgentName(memberName);
  if (!normalized) return [];
  const out: string[] = [];
  for (const m of listManifests()) {
    if (m.status !== "active") continue;
    if (!m.members.includes(normalized)) continue;
    if (m.round_status === "collected") continue;
    const contributors = contributorsInRound(m.council_id, m.current_round);
    if (contributors.includes(normalized)) continue;
    out.push(m.council_id);
  }
  return out;
}

/** Write a contribution file (atomic). Creates the round directory lazily. */
export function writeContribution(
  councilId: string,
  round: number,
  memberName: string,
  body: string,
): string {
  const filePath = contributionPath(councilId, round, memberName);
  if (!filePath) throw new Error("not in an agent session; no monorepo root");
  const rd = roundDir(councilId, round);
  if (rd && !existsSync(rd)) mkdirSync(rd, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, filePath);
  return filePath;
}

/**
 * Path to the round-N prompts directory: `.harnery/councils/<id>/round-N/prompts/`.
 * Sibling to the contribution files. Holds one `<member>.md` per non-self
 * council member, drafted by the steward, read by the operator (copy-paste
 * into each agent harness) and the web UI (per-member panel).
 */
export function promptsDir(councilId: string, round: number): string | null {
  const rd = roundDir(councilId, round);
  if (!rd) return null;
  return resolve(rd, "prompts");
}

/** Path to a single member's prompt file in a given round. Like
 * contributionPath, filename uses the agent's durable persona uuid. */
export function promptPath(councilId: string, round: number, memberName: string): string | null {
  const pd = promptsDir(councilId, round);
  if (!pd) return null;
  const id = ensureIdentity(memberName).agent_id;
  return resolve(pd, `${id}.md`);
}

/**
 * Build the routing header prepended to every steward-drafted prompt. The
 * contributor skill scans inbound messages for this comment block; if the
 * `member:` line does not match the receiving agent's whoami, the agent
 * refuses to contribute (catches operator misrouting). HTML-comment so it
 * renders invisibly in markdown previews.
 */
export function buildRouteHeader(councilId: string, round: number, memberName: string): string {
  const m = normalizeAgentName(memberName);
  return [
    "<!-- council-route",
    `council-id: ${councilId}`,
    `council-round: ${round}`,
    `member: ${m}`,
    "-->",
    "",
  ].join("\n");
}

/** Strip a leading route header from a prompt body, if present. */
export function stripRouteHeader(body: string): string {
  return body.replace(/^<!--\s*council-route[\s\S]*?-->\n?/, "");
}

/** Sentinel marking the start of the auto-appended submit footer. */
const SUBMIT_FOOTER_MARKER = "<!-- council-submit-footer -->";

/**
 * Build the submit footer appended to every steward-drafted prompt. This is the
 * load-bearing instruction that a contribution composed in chat is NOT recorded;
 * the agent must run the command below. It rides on the prompt (the one
 * artifact the operator always pastes) so it reaches every harness regardless of
 * whether the convene-time invitation was delivered or a `/council` skill is
 * available. Without it, agents (esp. non-Claude harnesses with no skill) write
 * their take as a reply and end the turn, leaving the council showing them as
 * still-pending. Visible markdown (not an HTML comment) so the agent reads it.
 */
export function buildSubmitFooter(councilId: string): string {
  const bin = resolveBinName();
  return [
    SUBMIT_FOOTER_MARKER,
    "---",
    "**⚠ To record your contribution you MUST run the command below; a reply in chat is NOT counted:**",
    "",
    "```bash",
    `${bin} agents council contribute ${councilId} --message "<your take, end with the status tag>"`,
    `# longer write-up? ${bin} agents council contribute ${councilId} --file <path>`,
    "```",
    "",
    '_(Or invoke the `council` skill in your harness: `/council contribute` in Claude Code, `$council` / "use the council skill" in Codex/Cursor, for the same flow with routing guards.)_',
  ].join("\n");
}

/** Strip an appended submit footer from a prompt body, if present. */
export function stripSubmitFooter(body: string): string {
  return body.replace(new RegExp(`\\n*${SUBMIT_FOOTER_MARKER}[\\s\\S]*$`), "");
}

/** Parse a route header from a string (the inbound user message). Returns
 * null when the comment is absent or malformed. Used by the /council
 * contribute skill to detect operator misrouting before contributing. */
export function parseRouteHeader(text: string): {
  council_id: string;
  council_round: number;
  member: string;
} | null {
  const m = text.match(/<!--\s*council-route\s*([\s\S]*?)-->/);
  if (!m) return null;
  const lines = m[1].split("\n");
  const get = (key: string): string | null => {
    for (const line of lines) {
      const mm = line.match(new RegExp(`^\\s*${key}:\\s*(.+)$`));
      if (mm) return mm[1].trim();
    }
    return null;
  };
  const councilId = get("council-id");
  const roundStr = get("council-round");
  const member = get("member");
  if (!councilId || !roundStr || !member) return null;
  const round = Number.parseInt(roundStr, 10);
  if (!Number.isFinite(round)) return null;
  return { council_id: councilId, council_round: round, member };
}

/** Write a prompt file (atomic). Creates the prompts dir lazily. The body
 * is automatically prepended with a route header (see `buildRouteHeader`) so
 * the contributor skill can verify the operator routed the prompt to the
 * right agent. */
export function writePrompt(
  councilId: string,
  round: number,
  memberName: string,
  body: string,
): string {
  const filePath = promptPath(councilId, round, memberName);
  if (!filePath) throw new Error("not in an agent session; no monorepo root");
  const pd = promptsDir(councilId, round);
  if (pd && !existsSync(pd)) mkdirSync(pd, { recursive: true });
  // Strip any existing route header + submit footer from `body` first so
  // re-writes don't stack them when a steward updates a prompt.
  const header = buildRouteHeader(councilId, round, memberName);
  const footer = buildSubmitFooter(councilId);
  const cleaned = stripSubmitFooter(stripRouteHeader(body)).trimEnd();
  const tmp = `${filePath}.tmp.${process.pid}`;
  writeFileSync(tmp, `${header}${cleaned}\n\n${footer}\n`, "utf8");
  renameSync(tmp, filePath);
  return filePath;
}

/**
 * Read a member's prompt for a given round. Returns null when the file
 * doesn't exist (steward hasn't drafted one yet). Includes a `completed`
 * boolean so the UI can mark the prompt deactivated once the contribution
 * has landed.
 */
export function readPrompt(
  councilId: string,
  round: number,
  memberName: string,
): { body: string; completed: boolean } | null {
  const filePath = promptPath(councilId, round, memberName);
  if (!filePath || !existsSync(filePath)) return null;
  const body = readFileSync(filePath, "utf8");
  const contributors = contributorsInRound(councilId, round);
  const completed = contributors.includes(normalizeAgentName(memberName));
  return { body, completed };
}

/**
 * Visual/behavioral state of a per-member routing prompt within a round:
 *
 * - `contributed`: the member already submitted; the prompt is preserved for
 *   audit but no longer actionable. UIs render it dimmed + struck-through.
 * - `active`: the first not-yet-contributed prompt in `manifest.members`
 *   order. This is the one the operator should route next. UIs highlight it.
 * - `queued`: drafted but waiting for an earlier member to contribute first.
 *   UIs render it dimmed with the Copy button disabled so the operator can't
 *   route it out of order.
 */
export type CouncilPromptState = "contributed" | "active" | "queued";

/**
 * Read every member's prompt for a round, in `manifest.members` order
 * (which is the agreed round-robin sequence; alphabetical is wrong because
 * stewards typically build councils with a deliberate first-to-last order).
 *
 * Each entry carries `order` (1-indexed position within manifest.members,
 * skipping members whose prompts don't exist) + `state` (contributed /
 * active / queued) so the UI can render the three-state pattern without
 * duplicating the active-determination logic.
 */
export function readRoundPrompts(
  manifest: CouncilManifest,
  round: number,
): Array<{
  member: string;
  body: string;
  completed: boolean;
  order: number;
  state: CouncilPromptState;
}> {
  const contributors = contributorsInRound(manifest.council_id, round);

  // First pass: collect drafted prompts in manifest order.
  type Row = {
    member: string;
    body: string;
    completed: boolean;
    order: number;
    state: CouncilPromptState;
  };
  const out: Row[] = [];
  for (const member of manifest.members) {
    const filePath = promptPath(manifest.council_id, round, member);
    if (!filePath || !existsSync(filePath)) continue;
    const body = readFileSync(filePath, "utf8");
    const completed = contributors.includes(normalizeAgentName(member));
    out.push({
      member,
      body,
      completed,
      order: out.length + 1,
      state: completed ? "contributed" : "queued", // placeholder; promoted below
    });
  }

  // Second pass: promote the first not-contributed entry to `active`.
  for (const row of out) {
    if (row.state !== "contributed") {
      row.state = "active";
      break;
    }
  }
  return out;
}
