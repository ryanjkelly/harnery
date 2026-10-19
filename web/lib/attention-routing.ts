import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { stateDirMode, stateFileMode } from "../../src/core/storage/modes.ts";
import {
  ATTENTION_ENGAGED_MS,
  ATTENTION_FRESH_MS,
  type AttentionObservation,
  type AttentionRouting,
} from "./attention-client";

export type AttentionPresence = AttentionObservation & {
  observedAt: number;
  interactionAt: number | null;
};
type Revision = {
  revision: number;
  eventKey: string;
  recipientId: string;
  generation: string;
  selectedAt: number;
  claimed: boolean;
};
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
export const validAttentionKey = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 2048;
export const validAttentionClient = validId;
const validTime = (value: unknown, now: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= now;
const fresh = (row: AttentionPresence, key: string, now: number) =>
  row.eventKey === key &&
  validTime(row.observedAt, now) &&
  now - row.observedAt < ATTENTION_FRESH_MS;
const engaged = (row: AttentionPresence, now: number) =>
  row.visible &&
  row.focused &&
  validTime(row.interactionAt, now) &&
  now - row.interactionAt < ATTENTION_ENGAGED_MS;

/** A current lease is sticky; this pure ranking chooses its next recipient. */
export function selectAttentionClient(
  clients: AttentionPresence[],
  eventKey: string,
  now: number,
): AttentionPresence | null {
  const rank = (row: AttentionPresence) => (engaged(row, now) ? 2 : row.visible ? 1 : 0);
  return (
    clients
      .filter((row) => fresh(row, eventKey, now))
      .sort(
        (a, b) =>
          rank(b) - rank(a) ||
          b.observedAt - a.observedAt ||
          (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0),
      )[0] ?? null
  );
}
function directory(root: string, suffix: string): string {
  const dir = path.join(root, ".harnery", "attention", suffix);
  mkdirSync(dir, { recursive: true, mode: stateDirMode() });
  return dir;
}
function eventDirectory(root: string, key: string): string {
  if (!validAttentionKey(key)) throw new Error("invalid_attention_key");
  return directory(root, path.join("events", createHash("sha256").update(key).digest("hex")));
}
function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function write(file: string, value: unknown, exclusive: boolean): boolean {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", stateFileMode());
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    if (exclusive) linkSync(temp, file);
    else renameSync(temp, file);
    syncDirectory(path.dirname(file));
    return true;
  } catch (error) {
    if (exclusive && (error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
}
function readOptional(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function presence(root: string): AttentionPresence[] {
  const dir = directory(root, "clients");
  return readdirSync(dir)
    .filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name))
    .map((name) => {
      const row = readOptional(path.join(dir, name)) as AttentionPresence;
      if (
        !row ||
        !validId(row.clientId) ||
        name !== `${row.clientId}.json` ||
        !(row.eventKey === null || validAttentionKey(row.eventKey)) ||
        typeof row.visible !== "boolean" ||
        typeof row.focused !== "boolean" ||
        !Number.isSafeInteger(row.interaction) ||
        row.interaction < 0 ||
        !(row.holdingGeneration === null || validId(row.holdingGeneration))
      )
        throw new Error("attention_presence_unreadable");
      return row;
    });
}
function latest(dir: string, key: string): Revision | null {
  const names = readdirSync(dir)
    .filter((name) => /^\d{12}\.json$/.test(name))
    .sort();
  const name = names.at(-1);
  if (!name) return null;
  const row = readOptional(path.join(dir, name)) as Revision;
  if (
    !row ||
    row.eventKey !== key ||
    !validId(row.recipientId) ||
    !validId(row.generation) ||
    !Number.isSafeInteger(row.revision) ||
    name !== `${String(row.revision).padStart(12, "0")}.json` ||
    typeof row.claimed !== "boolean" ||
    !Number.isFinite(row.selectedAt) ||
    row.selectedAt < 0
  )
    throw new Error("attention_revision_unreadable");
  return row;
}
function append(dir: string, row: Revision): boolean {
  return write(path.join(dir, `${String(row.revision).padStart(12, "0")}.json`), row, true);
}
function acknowledged(dir: string, key: string): boolean {
  const row = readOptional(path.join(dir, "ack.json")) as {
    eventKey: string;
    clientId: string;
    acknowledgedAt: number;
  } | null;
  if (!row) return false;
  if (
    row.eventKey !== key ||
    !validId(row.clientId) ||
    !Number.isFinite(row.acknowledgedAt) ||
    row.acknowledgedAt < 0
  )
    throw new Error("attention_acknowledgment_unreadable");
  return true;
}
function result(
  key: string | null,
  now: number,
  row: Revision | null = null,
  owner?: AttentionPresence,
): AttentionRouting {
  const expiry = row
    ? (row.claimed && owner?.holdingGeneration === row.generation
        ? owner.observedAt
        : row.selectedAt) + ATTENTION_FRESH_MS
    : now;
  return {
    eventKey: key,
    recipientId: row?.recipientId ?? null,
    generation: row?.generation ?? null,
    state: row ? (row.claimed ? "claimed" : "selected") : "waiting",
    granted: false,
    engaged: !!owner && engaged(owner, now),
    serverNow: now,
    expiresAt: expiry,
  };
}
function current(
  row: Revision | null,
  rows: AttentionPresence[],
  key: string,
  now: number,
): AttentionPresence | undefined {
  if (!row || !validTime(row.selectedAt, now)) return undefined;
  const owner = rows.find(
    (client) => client.clientId === row.recipientId && fresh(client, key, now),
  );
  if (!owner || result(key, now, row, owner).expiresAt <= now) return undefined;
  return owner;
}
function validateNow(now: number): void {
  if (!Number.isFinite(now) || now < 0) throw new Error("invalid_attention_clock");
}
export function observeAttention(
  root: string,
  observation: AttentionObservation,
  now = Date.now(),
): AttentionRouting {
  validateNow(now);
  if (
    !validId(observation.clientId) ||
    !(observation.eventKey === null || validAttentionKey(observation.eventKey)) ||
    !Number.isSafeInteger(observation.interaction) ||
    observation.interaction < 0 ||
    typeof observation.visible !== "boolean" ||
    typeof observation.focused !== "boolean" ||
    !(observation.holdingGeneration === null || validId(observation.holdingGeneration))
  )
    throw new Error("invalid_attention_observation");
  const file = path.join(directory(root, "clients"), `${observation.clientId}.json`);
  const prior = readOptional(file) as AttentionPresence | null;
  const row: AttentionPresence = {
    ...observation,
    observedAt: now,
    interactionAt:
      observation.interaction > (prior?.interaction ?? 0) ? now : (prior?.interactionAt ?? null),
  };
  if (row.holdingGeneration && row.eventKey) {
    const head = latest(eventDirectory(root, row.eventKey), row.eventKey);
    const priorDeadline = head
      ? (head.claimed && prior?.holdingGeneration === head.generation
          ? prior.observedAt
          : head.selectedAt) + ATTENTION_FRESH_MS
      : now;
    // A delayed heartbeat may renew a still-live grant, never revive an expired
    // generation after the client should already have stopped its channels.
    if (
      !head ||
      !head.claimed ||
      head.generation !== row.holdingGeneration ||
      head.recipientId !== row.clientId ||
      !prior ||
      !fresh(prior, row.eventKey, now) ||
      now >= priorDeadline
    )
      row.holdingGeneration = null;
  }
  // A lower interaction counter cannot later make an old token look new.
  row.interaction = Math.max(observation.interaction, prior?.interaction ?? 0);
  write(file, row, false);
  if (observation.eventKey === null) return result(null, now);
  const key = observation.eventKey,
    dir = eventDirectory(root, key);
  for (let attempt = 0; attempt < 16; attempt++) {
    if (acknowledged(dir, key)) return { ...result(key, now), state: "acknowledged" };
    const head = latest(dir, key),
      rows = presence(root),
      owner = current(head, rows, key, now);
    if (head && owner) return result(key, now, head, owner);
    const selected = selectAttentionClient(rows, key, now);
    if (!selected) return result(key, now);
    const next: Revision = {
      revision: (head?.revision ?? 0) + 1,
      eventKey: key,
      recipientId: selected.clientId,
      generation: randomUUID(),
      selectedAt: now,
      claimed: false,
    };
    if (append(dir, next)) return result(key, now, next, selected);
  }
  throw new Error("attention_revision_contention");
}
export function claimAttention(
  root: string,
  key: string,
  clientId: string,
  generation: string,
  now = Date.now(),
): AttentionRouting {
  validateNow(now);
  if (!validId(clientId) || !validId(generation)) throw new Error("invalid_attention_claim");
  const dir = eventDirectory(root, key);
  for (let attempt = 0; attempt < 16; attempt++) {
    if (acknowledged(dir, key)) return { ...result(key, now), state: "acknowledged" };
    const head = latest(dir, key),
      owner = current(head, presence(root), key, now);
    if (!head || !owner) return result(key, now);
    const reply = result(key, now, head, owner);
    if (head.recipientId !== clientId || head.generation !== generation || head.claimed)
      return reply;
    const next = { ...head, revision: head.revision + 1, claimed: true };
    if (append(dir, next)) return { ...result(key, now, next, owner), granted: true };
  }
  throw new Error("attention_revision_contention");
}
export function acknowledgeAttention(
  root: string,
  key: string,
  clientId: string,
  now = Date.now(),
): AttentionRouting {
  validateNow(now);
  if (!validId(clientId)) throw new Error("invalid_attention_client");
  const dir = eventDirectory(root, key);
  if (!presence(root).some((row) => row.clientId === clientId && fresh(row, key, now)))
    throw new Error("attention_client_not_current");
  write(path.join(dir, "ack.json"), { eventKey: key, clientId, acknowledgedAt: now }, true);
  return { ...result(key, now), state: "acknowledged" };
}
