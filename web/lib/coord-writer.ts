/**
 * Write-side helpers for the standalone web UI: operator-initiated mutations
 * on agents and their journals.
 *
 * - Release a claim, end a session, repair a coordination cache, and replace
 *   a journal shell `agent-coord` (through `runHarn`), so the coordination
 *   rules stay in the CLI.
 * - Ping uses the shared inbox writer (`sendPeerMessage`).
 * - Appending, editing, and deleting single journal entries call the core
 *   journal writers, which hold the project's journal lock and refuse a file
 *   whose timestamps need `journal migrate`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { isSafeInstanceId } from "harnery/core/agents";
import { sendPeerMessage } from "harnery/core/inbox";
import {
  appendEntry,
  deleteEntry,
  editEntry,
  JOURNAL_CATEGORIES,
  type JournalCategory,
} from "harnery/core/journal";
import { coordRoot } from "./coord-reader";
import { type HelperResult, runHarn } from "./run-harn";

export { JOURNAL_CATEGORIES, type JournalCategory };

function runHelper(args: string[]): Promise<HelperResult> {
  return runHarn(args, { executable: "agent-coord" });
}

/** Defensive instance_id validation: owner_ids are UUIDs in practice. */
export function safeOwnerId(owner: string): boolean {
  return isSafeInstanceId(owner);
}

/**
 * Resolve a canonical V3 instance ID back to the native cache owner when both
 * records describe the same generation. Operator actions can be rendered from
 * a projection-only `inst_*` row, while agent-coord must join the hook producer
 * with the adapter's native owner ID.
 */
export function resolveOperatorMutationOwner(
  instanceId: string,
  root: string = coordRoot(),
): string {
  if (!instanceId.startsWith("inst_")) return instanceId;
  const candidate = instanceId.slice("inst_".length);
  if (!safeOwnerId(candidate)) return instanceId;
  try {
    const cache = JSON.parse(
      readFileSync(path.join(root, ".harnery", "active", `${candidate}.json`), "utf8"),
    ) as Record<string, unknown>;
    if (
      cache.instance_id === candidate &&
      cache.v3_instance_id === instanceId &&
      typeof cache.v3_generation_id === "string"
    ) {
      return candidate;
    }
  } catch {
    // No validated native cache alias exists, so preserve the supplied owner.
  }
  return instanceId;
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
 * header matches the parser's expectation (`## YYYY-MM-DD H:MM AM/PM ±HH:MM · cat`),
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

  try {
    return editEntry(owner, index, expectedTsDisplay, newCategory, trimmed);
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
  try {
    return deleteEntry(owner, index, expectedTsDisplay);
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
  const result = await runHelper([
    "release-claim",
    resolveOperatorMutationOwner(instanceId),
    target,
  ]);
  if (!result.ok) {
    return {
      ok: false,
      instance_id: instanceId,
      path: target,
      removed: false,
      remaining: 0,
      error: result.stderr.trim() || `claim release exited ${result.exitCode}`,
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
  complete?: boolean;
  target_instance: string;
  bytes: number;
  error?: string;
  state?: "written-live" | "queued" | "remote" | "duplicate";
  message_id?: string;
  operation_id?: string;
  child?: ReturnType<typeof sendPeerMessage>["child"];
  parent_reference?: ReturnType<typeof sendPeerMessage>["parent_reference"];
  parent_copy?: ReturnType<typeof sendPeerMessage>["parent_copy"];
  partial_reason?: string;
}

export function pingAgent(targetInstanceId: string, message: string): PingResult {
  if (!safeOwnerId(targetInstanceId)) {
    return {
      ok: false,
      complete: false,
      target_instance: targetInstanceId,
      bytes: 0,
      error: "invalid instance_id",
    };
  }
  ensureCoordRootEnv();
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      ok: false,
      complete: false,
      target_instance: targetInstanceId,
      bytes: 0,
      error: "empty message",
    };
  }
  try {
    const sent = sendPeerMessage({
      coordRoot: coordRoot(),
      target: { instanceId: resolveOperatorMutationOwner(targetInstanceId, coordRoot()) },
      senderInstanceId: null,
      senderName: "Operator",
      body: message,
    });
    const routing = {
      complete: sent.complete,
      operation_id: sent.operation_id,
      child: sent.child,
      parent_reference: sent.parent_reference,
      parent_copy: sent.parent_copy,
      ...("ok" in sent.parent_copy && !sent.parent_copy.ok
        ? { partial_reason: sent.parent_copy.message }
        : {}),
    };
    if (!sent.ok)
      return {
        ...routing,
        ok: false,
        target_instance: targetInstanceId,
        bytes: 0,
        error: sent.message,
      };
    return {
      ...routing,
      ok: true,
      target_instance: sent.target.instance_id,
      bytes: sent.body_bytes,
      state: sent.state,
      message_id: sent.message_id,
    };
  } catch (err) {
    return {
      ok: false,
      complete: false,
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
      error: result.stderr.trim() || `session finalizer exited ${result.exitCode}`,
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
