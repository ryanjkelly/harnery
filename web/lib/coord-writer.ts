/**
 * Write-side helpers for the standalone web UI. These are operator-initiated
 * mutations: release a stale claim, ping a peer, end a stuck session.
 *
 * Direct fs writes (no flock, since they're operator-initiated and low frequency). The bash
 * coord layer's flock dance is for the agent-vs-agent race; the web UI is
 * the operator's escape hatch.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSafeInstanceId } from "harnery/core/agents";
import {
  appendEntry,
  archiveJournal,
  JOURNAL_CATEGORIES,
  type JournalCategory,
  journalPath,
  parseJournal,
  serializeJournal,
} from "harnery/core/journal";
import { coordRoot } from "./coord-reader";

export { JOURNAL_CATEGORIES, type JournalCategory };

interface HelperResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
}

function helperPath(): string {
  return path.join(coordRoot(), "harnery", "bin", "agent-coord");
}

function runHelper(args: string[]): Promise<HelperResult> {
  const root = coordRoot();
  return new Promise((resolve) => {
    const proc = spawn(helperPath(), args, {
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      resolve({ ok: code === 0, stdout, stderr, exit_code: code });
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        stdout,
        stderr: stderr + err.message,
        exit_code: null,
      });
    });
  });
}

/** Defensive instance_id validation: owner_ids are UUIDs in practice. */
export function safeOwnerId(owner: string): boolean {
  return isSafeInstanceId(owner);
}

/** Force a coord-layer recovery action on an agent. Shells to harnery/bin/agent-coord. */
export async function healAgent(owner: string, _kind: "cache"): Promise<HelperResult> {
  return runHelper(["repair-coordination-cache", owner]);
}

/**
 * Replace an agent's journal via the audit-marker pattern. Shells to
 * `agent-coord edit-journal <owner> <body-file> <summary>` which writes
 * the prior body to `.harnery/journal/archived/<owner>-pre-ui-<ts>.md` and
 * appends a synthetic `note` entry containing the new body to the live
 * journal. Body comes in as a string here; the helper expects a file
 * path, so we mkdtemp + write + invoke + cleanup.
 */
export async function editJournal(
  owner: string,
  newBody: string,
  summary: string,
): Promise<HelperResult> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harnery-journal-"));
  const tmpFile = path.join(tmpDir, "body.md");
  try {
    await fs.writeFile(tmpFile, newBody, "utf-8");
    return await runHelper(["edit-journal", owner, tmpFile, summary]);
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Append one well-formed entry to an agent's journal. Uses the same
 * `appendEntry` helper the in-process middleware uses, so the resulting
 * header matches the parser's expectation (`## YYYY-MM-DD H:MM AM/PM CDT · cat`),
 * so entries created here show up in the entries timeline immediately.
 *
 * Distinct from `editJournal`: the latter does wholesale replace (audit
 * archive + synthetic note), which is what created the corrupted-looking
 * nested files. Operators should append by default; replace is the escape
 * hatch.
 */
export interface AppendEntryResult {
  ok: boolean;
  bytes?: number;
  entries?: number;
  error?: string;
}

export function appendJournalEntry(
  owner: string,
  category: JournalCategory,
  body: string,
): AppendEntryResult {
  ensureCoordRootEnv();
  if (!JOURNAL_CATEGORIES.includes(category)) {
    return { ok: false, error: `invalid category: ${category}` };
  }
  const trimmed = body.trim();
  if (!trimmed) {
    return { ok: false, error: "body is empty" };
  }
  try {
    const doc = appendEntry(owner, category, trimmed);
    return { ok: true, bytes: doc.bytes, entries: doc.entries.length };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Edit an existing journal entry by its newest-first index. Archives the
 * current file first (audit trail), then rewrites with the edited body /
 * category. `expectedTsDisplay` is a sanity check: if another writer raced
 * in between view and submit, we refuse to clobber the wrong entry.
 */
export interface MutateEntryResult {
  ok: boolean;
  bytes?: number;
  entries?: number;
  error?: string;
}

export function editJournalEntry(
  owner: string,
  index: number,
  expectedTsDisplay: string,
  newCategory: JournalCategory,
  newBody: string,
): MutateEntryResult {
  ensureCoordRootEnv();
  if (!JOURNAL_CATEGORIES.includes(newCategory)) {
    return { ok: false, error: `invalid category: ${newCategory}` };
  }
  const trimmed = newBody.trim();
  if (!trimmed) return { ok: false, error: "body is empty" };

  const filePath = journalPath(owner);
  if (!existsSync(filePath)) {
    return { ok: false, error: "journal not found" };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const doc = parseJournal(filePath, content);
    if (index < 0 || index >= doc.entries.length) {
      return { ok: false, error: `index ${index} out of range` };
    }
    const target = doc.entries[index];
    if (target.ts_display !== expectedTsDisplay) {
      return {
        ok: false,
        error: `entry at index ${index} no longer matches (someone else may have edited)`,
      };
    }
    archiveJournal(owner);
    target.category = newCategory;
    target.body = trimmed;
    // Don't touch ts_iso / ts_display; the edit preserves identity.
    const serialized = serializeJournal(doc);
    writeFileSync(filePath, serialized, "utf-8");
    return {
      ok: true,
      bytes: Buffer.byteLength(serialized, "utf-8"),
      entries: doc.entries.length,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function deleteJournalEntry(
  owner: string,
  index: number,
  expectedTsDisplay: string,
): MutateEntryResult {
  ensureCoordRootEnv();
  const filePath = journalPath(owner);
  if (!existsSync(filePath)) {
    return { ok: false, error: "journal not found" };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const doc = parseJournal(filePath, content);
    if (index < 0 || index >= doc.entries.length) {
      return { ok: false, error: `index ${index} out of range` };
    }
    if (doc.entries[index].ts_display !== expectedTsDisplay) {
      return {
        ok: false,
        error: `entry at index ${index} no longer matches (someone else may have edited)`,
      };
    }
    archiveJournal(owner);
    doc.entries.splice(index, 1);
    const serialized = serializeJournal(doc);
    writeFileSync(filePath, serialized, "utf-8");
    return {
      ok: true,
      bytes: Buffer.byteLength(serialized, "utf-8"),
      entries: doc.entries.length,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// harnery's journal lib reads monorepoRoot() via git rev-parse. The web
// server runs from the harnery/web/ workspace, so overriding lets it write
// into the same .harnery/ the page is reading from, without depending on
// git's view (and without spawning git per request).
function ensureCoordRootEnv(): void {
  if (!process.env.HARNERY_COORD_ROOT_OVERRIDE) {
    process.env.HARNERY_COORD_ROOT_OVERRIDE = coordRoot();
  }
}

export interface ReleaseClaimResult {
  ok: boolean;
  instance_id: string;
  path: string;
  removed: boolean;
  remaining: number;
  error?: string;
}

export async function releaseClaim(
  instanceId: string,
  target: string,
): Promise<ReleaseClaimResult> {
  if (!safeOwnerId(instanceId)) {
    return {
      ok: false,
      instance_id: instanceId,
      path: target,
      removed: false,
      remaining: 0,
      error: "invalid instance_id",
    };
  }
  const result = await runHelper(["release-claim", instanceId, target]);
  if (!result.ok) {
    return {
      ok: false,
      instance_id: instanceId,
      path: target,
      removed: false,
      remaining: 0,
      error: result.stderr.trim() || `claim release exited ${result.exit_code}`,
    };
  }
  let filesTouched: string[] = [];
  try {
    const payload = JSON.parse(result.stdout.trim()) as { files_touched?: unknown };
    filesTouched = Array.isArray(payload.files_touched)
      ? payload.files_touched.filter((value): value is string => typeof value === "string")
      : [];
  } catch (error) {
    return {
      ok: false,
      instance_id: instanceId,
      path: target,
      removed: false,
      remaining: 0,
      error: `invalid claim-release response: ${(error as Error).message}`,
    };
  }
  return {
    ok: true,
    instance_id: instanceId,
    path: target,
    removed: !filesTouched.includes(target),
    remaining: filesTouched.length,
  };
}

export interface PingResult {
  ok: boolean;
  target_instance: string;
  bytes: number;
  error?: string;
}

export function pingAgent(targetInstanceId: string, message: string): PingResult {
  if (!safeOwnerId(targetInstanceId)) {
    return {
      ok: false,
      target_instance: targetInstanceId,
      bytes: 0,
      error: "invalid instance_id",
    };
  }
  ensureCoordRootEnv();
  const trimmed = message.trim();
  if (!trimmed) {
    return { ok: false, target_instance: targetInstanceId, bytes: 0, error: "empty message" };
  }
  const body = `from web-ui: ${trimmed}`;
  try {
    const doc = appendEntry(targetInstanceId, "handoff", body);
    return { ok: true, target_instance: targetInstanceId, bytes: doc.bytes };
  } catch (err) {
    return {
      ok: false,
      target_instance: targetInstanceId,
      bytes: 0,
      error: (err as Error).message,
    };
  }
}

export interface EndSessionResult {
  ok: boolean;
  instance_id: string;
  terminal_event_recorded: boolean;
  terminal_event_queued: boolean;
  request_id?: string;
  error?: string;
}

export async function endSession(instanceId: string): Promise<EndSessionResult> {
  if (!safeOwnerId(instanceId)) {
    return {
      ok: false,
      instance_id: instanceId,
      terminal_event_recorded: false,
      terminal_event_queued: false,
      error: "invalid instance_id",
    };
  }
  const result = await runHelper(["end-session", instanceId]);
  if (!result.ok) {
    return {
      ok: false,
      instance_id: instanceId,
      terminal_event_recorded: false,
      terminal_event_queued: false,
      error: result.stderr.trim() || `session finalizer exited ${result.exit_code}`,
    };
  }
  try {
    const payload = JSON.parse(result.stdout.trim()) as {
      state?: string;
      request?: { request_id?: string };
    };
    const queued = payload.state === "queued" || payload.state === "already_requested";
    const recorded = payload.state === "recorded" || payload.state === "already_ended";
    if (!queued && !recorded) throw new Error(`unexpected finalizer state: ${payload.state}`);
    return {
      ok: true,
      instance_id: instanceId,
      terminal_event_recorded: recorded,
      terminal_event_queued: queued,
      ...(payload.request?.request_id ? { request_id: payload.request.request_id } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      instance_id: instanceId,
      terminal_event_recorded: false,
      terminal_event_queued: false,
      error: `invalid finalizer response: ${(err as Error).message}`,
    };
  }
}
