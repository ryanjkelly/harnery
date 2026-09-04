/**
 * Private, consume-once delivery state for Cursor prompt context.
 *
 * Cursor cannot accept model context from beforeSubmitPrompt. SessionStart can
 * set an environment variable, so Harnery issues one opaque key there and
 * stages each later turn under the key's SHA-256 digest. Raw keys, conversation
 * ids, and native turn ids never reach disk. Pending context is the only
 * sensitive value stored, in a mode-0600 atomic file below mode-0700 dirs.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const PROMPT_CONTEXT_SESSION_KEY_ENV = "HARNERY_PROMPT_CONTEXT_SESSION_KEY" as const;
export const DEFAULT_PROMPT_CONTEXT_TTL_MS = 5 * 60_000;
export const DEFAULT_PROMPT_CONTEXT_SESSION_TTL_MS = 24 * 60 * 60_000;

const SESSION_SCHEMA = "harnery.prompt-context-session-state/v1" as const;
const PENDING_SCHEMA = "harnery.prompt-context-pending-state/v1" as const;

interface SessionStateV1 {
  schema: typeof SESSION_SCHEMA;
  key_hash: string;
  conversation_hash: string;
  created_at_ms: number;
  expires_at_ms: number;
}

interface PendingStateV1 {
  schema: typeof PENDING_SCHEMA;
  key_hash: string;
  conversation_hash: string;
  turn_hash: string;
  context: string;
  created_at_ms: number;
  expires_at_ms: number;
  recovery_sent: boolean;
}

export interface CursorPromptContextSession {
  sessionKey: string;
  expiresAtMs: number;
}

export type CursorPromptContextStageResult =
  | { staged: true; expiresAtMs: number }
  | { staged: false; reason: "empty_context" | "missing_session" | "expired_session" };

export type CursorPromptContextConsumeResult =
  | {
      status: "consumed";
      context: string;
      conversationFingerprint: string;
      turnFingerprint: string;
    }
  | { status: "empty" | "expired" | "invalid_key" };

export interface CursorPromptContextRecoveryResult {
  send: boolean;
  reason: "pending" | "already_sent" | "empty" | "expired";
}

export function startCursorPromptContextSession(input: {
  coordRoot: string;
  conversationId: string;
  nowMs?: number;
  sessionTtlMs?: number;
}): CursorPromptContextSession {
  const nowMs = input.nowMs ?? Date.now();
  const sessionTtlMs = positiveTtl(input.sessionTtlMs, DEFAULT_PROMPT_CONTEXT_SESSION_TTL_MS);
  const dirs = ensureStateDirs(input.coordRoot);
  cleanupExpiredCursorPromptContext(input.coordRoot, nowMs);

  const conversationHash = digest(input.conversationId);
  const sessionPath = join(dirs.sessions, `${conversationHash}.json`);
  const previous = readSession(sessionPath);
  if (previous) {
    removeFile(join(dirs.pending, `${previous.key_hash}.json`));
    removeClaimsForKey(dirs.claims, previous.key_hash);
  }

  const sessionKey = randomBytes(32).toString("base64url");
  const state: SessionStateV1 = {
    schema: SESSION_SCHEMA,
    key_hash: digest(sessionKey),
    conversation_hash: conversationHash,
    created_at_ms: nowMs,
    expires_at_ms: nowMs + sessionTtlMs,
  };
  atomicPrivateWrite(sessionPath, state);
  return { sessionKey, expiresAtMs: state.expires_at_ms };
}

export function stageCursorPromptContext(input: {
  coordRoot: string;
  conversationId: string;
  turnId: string;
  context: string;
  nowMs?: number;
  ttlMs?: number;
}): CursorPromptContextStageResult {
  const nowMs = input.nowMs ?? Date.now();
  const ttlMs = positiveTtl(input.ttlMs, DEFAULT_PROMPT_CONTEXT_TTL_MS);
  const dirs = ensureStateDirs(input.coordRoot);
  cleanupExpiredCursorPromptContext(input.coordRoot, nowMs);

  const conversationHash = digest(input.conversationId);
  const sessionPath = join(dirs.sessions, `${conversationHash}.json`);
  const session = readSession(sessionPath);
  if (!session) return { staged: false, reason: "missing_session" };
  if (session.expires_at_ms <= nowMs) {
    removeFile(sessionPath);
    removeFile(join(dirs.pending, `${session.key_hash}.json`));
    return { staged: false, reason: "expired_session" };
  }

  const pendingPath = join(dirs.pending, `${session.key_hash}.json`);
  if (input.context.length === 0) {
    // A no-match turn must also retire any unconsumed result from the prior
    // turn, or a delayed consume could surface stale customer context.
    removeFile(pendingPath);
    return { staged: false, reason: "empty_context" };
  }

  const pending: PendingStateV1 = {
    schema: PENDING_SCHEMA,
    key_hash: session.key_hash,
    conversation_hash: conversationHash,
    turn_hash: digest(input.turnId),
    context: input.context,
    created_at_ms: nowMs,
    expires_at_ms: nowMs + ttlMs,
    recovery_sent: false,
  };
  atomicPrivateWrite(pendingPath, pending);
  return { staged: true, expiresAtMs: pending.expires_at_ms };
}

export function consumeCursorPromptContext(input: {
  coordRoot: string;
  sessionKey: string;
  nowMs?: number;
}): CursorPromptContextConsumeResult {
  const nowMs = input.nowMs ?? Date.now();
  if (!validSessionKey(input.sessionKey)) return { status: "invalid_key" };

  const dirs = ensureStateDirs(input.coordRoot);
  cleanupExpiredCursorPromptContext(input.coordRoot, nowMs);
  const keyHash = digest(input.sessionKey);
  const pendingPath = join(dirs.pending, `${keyHash}.json`);
  if (!existsSync(pendingPath)) return { status: "empty" };

  const claimPath = join(dirs.claims, `${keyHash}-${digest(randomBytes(32))}.json`);
  try {
    renameSync(pendingPath, claimPath);
  } catch {
    // Another process won the atomic claim, or the file disappeared between
    // exists and rename. Both mean this caller has nothing to consume.
    return { status: "empty" };
  }

  try {
    const pending = readPending(claimPath);
    if (!pending || pending.key_hash !== keyHash) return { status: "empty" };
    if (pending.expires_at_ms <= nowMs) return { status: "expired" };
    return {
      status: "consumed",
      context: pending.context,
      conversationFingerprint: pending.conversation_hash,
      turnFingerprint: pending.turn_hash,
    };
  } finally {
    removeFile(claimPath);
  }
}

/** Mark one still-pending native turn for a single bounded Stop recovery. */
export function markCursorPromptContextRecovery(input: {
  coordRoot: string;
  conversationId: string;
  nowMs?: number;
}): CursorPromptContextRecoveryResult {
  const nowMs = input.nowMs ?? Date.now();
  const dirs = ensureStateDirs(input.coordRoot);
  cleanupExpiredCursorPromptContext(input.coordRoot, nowMs);
  const conversationHash = digest(input.conversationId);
  const session = readSession(join(dirs.sessions, `${conversationHash}.json`));
  if (!session) return { send: false, reason: "empty" };
  const pendingPath = join(dirs.pending, `${session.key_hash}.json`);
  const claimPath = join(dirs.claims, `${session.key_hash}-${digest(randomBytes(32))}.json`);
  try {
    renameSync(pendingPath, claimPath);
  } catch {
    return { send: false, reason: "empty" };
  }
  const pending = readPending(claimPath);
  if (!pending) {
    removeFile(claimPath);
    return { send: false, reason: "empty" };
  }
  if (pending.expires_at_ms <= nowMs) {
    removeFile(claimPath);
    return { send: false, reason: "expired" };
  }
  if (pending.key_hash !== session.key_hash || pending.conversation_hash !== conversationHash) {
    removeFile(claimPath);
    return { send: false, reason: "empty" };
  }
  if (pending.recovery_sent) {
    const restored = restoreClaim(claimPath, pendingPath, pending);
    return { send: false, reason: restored ? "already_sent" : "empty" };
  }
  const restored = restoreClaim(claimPath, pendingPath, { ...pending, recovery_sent: true });
  return restored ? { send: true, reason: "pending" } : { send: false, reason: "empty" };
}

/** Remove one Cursor session and any pending envelope tied to it. */
export function clearCursorPromptContextSession(input: {
  coordRoot: string;
  conversationId: string;
  nowMs?: number;
}): void {
  const dirs = stateDirs(input.coordRoot);
  if (!existsSync(dirs.root)) return;
  const conversationHash = digest(input.conversationId);
  const sessionPath = join(dirs.sessions, `${conversationHash}.json`);
  const session = readSession(sessionPath);
  if (session) {
    removeFile(join(dirs.pending, `${session.key_hash}.json`));
    removeClaimsForKey(dirs.claims, session.key_hash);
  }
  removeFile(sessionPath);
  cleanupExpiredCursorPromptContext(input.coordRoot, input.nowMs ?? Date.now());
}

/** Delete expired session/pending records and abandoned atomic claims. */
export function cleanupExpiredCursorPromptContext(coordRoot: string, nowMs = Date.now()): void {
  const dirs = ensureStateDirs(coordRoot);
  for (const name of jsonFiles(dirs.sessions)) {
    const path = join(dirs.sessions, name);
    const session = readSession(path);
    if (!session || session.expires_at_ms <= nowMs) {
      if (session) {
        removeFile(join(dirs.pending, `${session.key_hash}.json`));
        removeClaimsForKey(dirs.claims, session.key_hash);
      }
      removeFile(path);
    }
  }
  for (const name of jsonFiles(dirs.pending)) {
    const path = join(dirs.pending, name);
    const pending = readPending(path);
    if (!pending || pending.expires_at_ms <= nowMs) removeFile(path);
  }
  // A claim represents a consume that already won. Replaying an expired claim
  // would violate consume-once semantics, so janitor cleanup discards it.
  for (const name of jsonFiles(dirs.claims)) {
    const path = join(dirs.claims, name);
    const claim = readPending(path);
    if (!claim || claim.expires_at_ms <= nowMs) removeFile(path);
  }
  removeTemporaryFiles(dirs.sessions);
  removeTemporaryFiles(dirs.pending);
}

function stateDirs(coordRoot: string): {
  root: string;
  sessions: string;
  pending: string;
  claims: string;
} {
  const root = join(coordRoot, ".harnery", "runtime", "prompt-context");
  return {
    root,
    sessions: join(root, "sessions"),
    pending: join(root, "pending"),
    claims: join(root, "claims"),
  };
}

function ensureStateDirs(coordRoot: string): ReturnType<typeof stateDirs> {
  const dirs = stateDirs(coordRoot);
  for (const path of [dirs.root, dirs.sessions, dirs.pending, dirs.claims]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    try {
      chmodSync(path, 0o700);
    } catch {
      // Some filesystems cannot represent POSIX modes. Creation still uses the
      // strict mode where supported; state never falls back outside this root.
    }
  }
  return dirs;
}

function atomicPrivateWrite(path: string, value: SessionStateV1 | PendingStateV1): void {
  const dir = dirname(path);
  const tempPath = join(dir, `${digest(randomBytes(32))}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } finally {
    removeFile(tempPath);
  }
}

/**
 * Put a recovery claim back only when no newer turn has staged a pending file.
 * A hard-link create is atomic and refuses an existing destination, avoiding
 * the check-then-rename overwrite race on both POSIX and Windows filesystems.
 */
function restoreClaim(claimPath: string, pendingPath: string, value: PendingStateV1): boolean {
  writeFileSync(claimPath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(claimPath, 0o600);
    linkSync(claimPath, pendingPath);
    return true;
  } catch {
    return false;
  } finally {
    removeFile(claimPath);
  }
}

function removeClaimsForKey(claimDir: string, keyHash: string): void {
  for (const name of readdirSync(claimDir)) {
    if (name.startsWith(`${keyHash}-`)) removeFile(join(claimDir, name));
  }
}

function readSession(path: string): SessionStateV1 | null {
  const value = readJson(path);
  if (
    !isRecord(value) ||
    value.schema !== SESSION_SCHEMA ||
    !isDigest(value.key_hash) ||
    !isDigest(value.conversation_hash) ||
    !Number.isFinite(value.created_at_ms) ||
    !Number.isFinite(value.expires_at_ms)
  ) {
    return null;
  }
  return value as unknown as SessionStateV1;
}

function readPending(path: string): PendingStateV1 | null {
  const value = readJson(path);
  if (
    !isRecord(value) ||
    value.schema !== PENDING_SCHEMA ||
    !isDigest(value.key_hash) ||
    !isDigest(value.conversation_hash) ||
    !isDigest(value.turn_hash) ||
    typeof value.context !== "string" ||
    typeof value.recovery_sent !== "boolean" ||
    !Number.isFinite(value.created_at_ms) ||
    !Number.isFinite(value.expires_at_ms)
  ) {
    return null;
  }
  return value as unknown as PendingStateV1;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function removeTemporaryFiles(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".tmp")) removeFile(join(dir, name));
  }
}

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith(".json"));
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing and concurrently claimed files are already in the desired state.
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validSessionKey(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").byteLength === 32;
  } catch {
    return false;
  }
}

function positiveTtl(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
