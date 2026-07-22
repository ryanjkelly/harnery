/**
 * Write-side helpers for the standalone web UI. These are operator-initiated
 * mutations: release a stale claim, ping a peer, end a stuck session.
 *
 * Direct fs writes (no flock, since they're operator-initiated and low frequency). The bash
 * coord layer's flock dance is for the agent-vs-agent race; the web UI is
 * the operator's escape hatch.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isSafeInstanceId } from "harnery/core/agents";
import {
  appendEntry,
  archiveScratch,
  parseScratch,
  SCRATCH_CATEGORIES,
  type ScratchCategory,
  scratchPath,
  serializeScratch,
} from "harnery/core/scratch";
import { activeDir, coordRoot } from "./coord-reader";

export { SCRATCH_CATEGORIES, type ScratchCategory };

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
export async function healAgent(
  owner: string,
  kind: "pidmap" | "heartbeat" | "kill",
): Promise<HelperResult> {
  const action =
    kind === "pidmap" ? "heal-pidmap" : kind === "heartbeat" ? "heal-heartbeat" : "kill-heartbeat";
  return runHelper([action, owner]);
}

/**
 * Replace an agent's scratchpad via the audit-marker pattern. Shells to
 * `agent-coord edit-scratchpad <owner> <body-file> <summary>` which writes
 * the prior body to `.harnery/scratch/archived/<owner>-pre-ui-<ts>.md` and
 * appends a synthetic `note` entry containing the new body to the live
 * scratchpad. Body comes in as a string here; the helper expects a file
 * path, so we mkdtemp + write + invoke + cleanup.
 */
export async function editScratchpad(
  owner: string,
  newBody: string,
  summary: string,
): Promise<HelperResult> {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harnery-scratch-"));
  const tmpFile = path.join(tmpDir, "body.md");
  try {
    await fs.writeFile(tmpFile, newBody, "utf-8");
    return await runHelper(["edit-scratchpad", owner, tmpFile, summary]);
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Append one well-formed entry to an agent's scratchpad. Uses the same
 * `appendEntry` helper the in-process middleware uses, so the resulting
 * header matches the parser's expectation (`## YYYY-MM-DD H:MM AM/PM CDT · cat`),
 * so entries created here show up in the entries timeline immediately.
 *
 * Distinct from `editScratchpad`: the latter does wholesale replace (audit
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

export function appendScratchEntry(
  owner: string,
  category: ScratchCategory,
  body: string,
): AppendEntryResult {
  ensureCoordRootEnv();
  if (!SCRATCH_CATEGORIES.includes(category)) {
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
 * Edit an existing scratchpad entry by its newest-first index. Archives the
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

export function editScratchEntry(
  owner: string,
  index: number,
  expectedTsDisplay: string,
  newCategory: ScratchCategory,
  newBody: string,
): MutateEntryResult {
  ensureCoordRootEnv();
  if (!SCRATCH_CATEGORIES.includes(newCategory)) {
    return { ok: false, error: `invalid category: ${newCategory}` };
  }
  const trimmed = newBody.trim();
  if (!trimmed) return { ok: false, error: "body is empty" };

  const filePath = scratchPath(owner);
  if (!existsSync(filePath)) {
    return { ok: false, error: "scratchpad not found" };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const doc = parseScratch(filePath, content);
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
    archiveScratch(owner);
    target.category = newCategory;
    target.body = trimmed;
    // Don't touch ts_iso / ts_display; the edit preserves identity.
    const serialized = serializeScratch(doc);
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

export function deleteScratchEntry(
  owner: string,
  index: number,
  expectedTsDisplay: string,
): MutateEntryResult {
  ensureCoordRootEnv();
  const filePath = scratchPath(owner);
  if (!existsSync(filePath)) {
    return { ok: false, error: "scratchpad not found" };
  }
  try {
    const content = readFileSync(filePath, "utf-8");
    const doc = parseScratch(filePath, content);
    if (index < 0 || index >= doc.entries.length) {
      return { ok: false, error: `index ${index} out of range` };
    }
    if (doc.entries[index].ts_display !== expectedTsDisplay) {
      return {
        ok: false,
        error: `entry at index ${index} no longer matches (someone else may have edited)`,
      };
    }
    archiveScratch(owner);
    doc.entries.splice(index, 1);
    const serialized = serializeScratch(doc);
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

// harnery's scratch lib reads monorepoRoot() via git rev-parse. The web
// server runs from the harnery/web/ workspace, so overriding lets it write
// into the same .harnery/ the page is reading from, without depending on
// git's view (and without spawning git per request).
function ensureCoordRootEnv(): void {
  if (!process.env.HARNERY_COORD_ROOT_OVERRIDE) {
    process.env.HARNERY_COORD_ROOT_OVERRIDE = coordRoot();
  }
}

export interface HeartbeatFile {
  instance_id: string;
  name?: string;
  files_touched?: string[];
  [key: string]: unknown;
}

function heartbeatPath(instanceId: string): string {
  if (!safeOwnerId(instanceId)) throw new Error("invalid instance_id");
  return path.join(activeDir(), `${instanceId}.json`);
}

function readHeartbeatFile(instanceId: string): HeartbeatFile | null {
  const p = heartbeatPath(instanceId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as HeartbeatFile;
  } catch {
    return null;
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

export function releaseClaim(instanceId: string, target: string): ReleaseClaimResult {
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
  const hb = readHeartbeatFile(instanceId);
  if (!hb) {
    return {
      ok: false,
      instance_id: instanceId,
      path: target,
      removed: false,
      remaining: 0,
      error: "heartbeat not found",
    };
  }
  const before = (hb.files_touched ?? []).length;
  const filtered = (hb.files_touched ?? []).filter((p) => p !== target);
  hb.files_touched = filtered;
  writeFileSync(heartbeatPath(instanceId), `${JSON.stringify(hb, null, 2)}\n`, "utf-8");
  return {
    ok: true,
    instance_id: instanceId,
    path: target,
    removed: filtered.length < before,
    remaining: filtered.length,
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
  removed_from: string;
  error?: string;
}

export function endSession(instanceId: string): EndSessionResult {
  if (!safeOwnerId(instanceId)) {
    return { ok: false, instance_id: instanceId, removed_from: "", error: "invalid instance_id" };
  }
  const p = heartbeatPath(instanceId);
  if (!existsSync(p)) {
    return {
      ok: false,
      instance_id: instanceId,
      removed_from: p,
      error: "heartbeat not found",
    };
  }
  try {
    unlinkSync(p);
    return { ok: true, instance_id: instanceId, removed_from: p };
  } catch (err) {
    return {
      ok: false,
      instance_id: instanceId,
      removed_from: p,
      error: (err as Error).message,
    };
  }
}
