/**
 * Machine-local index of write claims in extra finalization roots (ADR 0267).
 *
 * A claim on a path outside the coordination repository is an `external_path`
 * target, which the V3 contract records without a path. The closing check
 * needs that path to see the claim. This index keeps it on the machine where
 * the claim was made, under `.harnery/finalization-paths/<instance>.json`:
 * never in the ledger, never tracked, never synced.
 *
 * One file per instance. Each entry names the session generation, the claim's
 * canonical absolute path, its configured finalization root, the ledger
 * target fingerprint when the acquisition recorded one, and whether the claim
 * is held or released. A released entry stays until the session claims the
 * path again, matching `released_paths` (ADR 0264).
 *
 * The index grants nothing. Only the finalization read uses it; the edit and
 * commit guards never read it, so it cannot block a peer. Writes take a
 * per-file lock directory and replace the file with temp-then-rename. A write
 * never replaces a file it cannot parse; the read fails closed on that file
 * until `rm` removes it (ADR 0267).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "./atomic-write.ts";

export const FINALIZATION_PATH_INDEX_VERSION = 1 as const;

/** Files untouched this long belong to sessions that are gone. */
export const FINALIZATION_PATH_INDEX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;

export interface FinalizationPathIndexEntry {
  generation_id: string;
  /** Canonical absolute claim path, as `canonicalClaimPath` returns it. */
  path: string;
  /** The configured `agents.finalizationRoots` path that contains it. */
  root: string;
  target_digest?: string;
  state: "held" | "released";
  updated_at: string;
}

interface FinalizationPathIndexFile {
  version: typeof FINALIZATION_PATH_INDEX_VERSION;
  instance_id: string;
  entries: FinalizationPathIndexEntry[];
}

export type FinalizationPathIndexRead =
  | { state: "missing" }
  | { state: "corrupt"; file: string }
  | { state: "ok"; held: string[]; released: string[] };

/**
 * A write met an index file it cannot parse. The writer never replaces it:
 * the read side already fails closed on that file, and replacing it would
 * silently drop the entries it held.
 */
export class FinalizationPathIndexUnreadableError extends Error {
  constructor(readonly file: string) {
    super(`finalization path index is unreadable: ${file}`);
    this.name = "FinalizationPathIndexUnreadableError";
  }
}

export function finalizationPathIndexDir(coordRoot: string): string {
  return join(coordRoot, ".harnery", "finalization-paths");
}

function indexFile(coordRoot: string, instanceId: string): string {
  return join(finalizationPathIndexDir(coordRoot), `${encodeURIComponent(instanceId)}.json`);
}

function parseIndex(raw: string, instanceId: string): FinalizationPathIndexFile | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const file = body as Partial<FinalizationPathIndexFile>;
  if (
    file.version !== FINALIZATION_PATH_INDEX_VERSION ||
    file.instance_id !== instanceId ||
    !Array.isArray(file.entries)
  ) {
    return null;
  }
  for (const entry of file.entries as unknown[]) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Partial<FinalizationPathIndexEntry>;
    if (
      typeof e.generation_id !== "string" ||
      typeof e.path !== "string" ||
      e.path.length === 0 ||
      typeof e.root !== "string" ||
      (e.state !== "held" && e.state !== "released") ||
      typeof e.updated_at !== "string" ||
      (e.target_digest !== undefined && typeof e.target_digest !== "string")
    ) {
      return null;
    }
  }
  return file as FinalizationPathIndexFile;
}

/** This generation's indexed paths. A missing file is not an error; an unreadable one is. */
export function readFinalizationPathIndex(
  coordRoot: string,
  instanceId: string,
  generationId: string,
): FinalizationPathIndexRead {
  const path = indexFile(coordRoot, instanceId);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "corrupt", file: path };
  }
  const file = parseIndex(raw, instanceId);
  if (!file) return { state: "corrupt", file: path };
  const current = file.entries.filter((entry) => entry.generation_id === generationId);
  const held = current.filter((entry) => entry.state === "held").map((entry) => entry.path);
  const released = current
    .filter((entry) => entry.state === "released" && !held.includes(entry.path))
    .map((entry) => entry.path);
  return {
    state: "ok",
    held: [...new Set(held)].sort(),
    released: [...new Set(released)].sort(),
  };
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withIndexLock<T>(file: string, body: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(join(file, ".."), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lock);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) throw new Error("finalization path index is locked");
      sleepSync(10);
    }
  }
  try {
    return body();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      /* a stale-lock sweep by another writer already removed it */
    }
  }
}

/**
 * Record one acquisition or release of an indexed path for this generation.
 * Entries from other generations are dropped on every write. A release of a
 * path that was never indexed changes nothing.
 */
export function recordFinalizationPathClaim(
  coordRoot: string,
  input: {
    instanceId: string;
    generationId: string;
    operation: "acquired" | "released";
    path: string;
    root: string;
    targetDigest?: string;
    now?: Date;
  },
): void {
  const file = indexFile(coordRoot, input.instanceId);
  withIndexLock(file, () => {
    const prior = readForWrite(file, input.instanceId);
    const entries = (prior?.entries ?? []).filter(
      (entry) => entry.generation_id === input.generationId,
    );
    const existing = entries.find((entry) => entry.path === input.path);
    const updatedAt = (input.now ?? new Date()).toISOString();
    if (input.operation === "acquired") {
      const next: FinalizationPathIndexEntry = {
        generation_id: input.generationId,
        path: input.path,
        root: input.root,
        ...(input.targetDigest
          ? { target_digest: input.targetDigest }
          : existing?.target_digest
            ? { target_digest: existing.target_digest }
            : {}),
        state: "held",
        updated_at: updatedAt,
      };
      if (existing) entries.splice(entries.indexOf(existing), 1, next);
      else entries.push(next);
    } else {
      if (!existing) {
        // Nothing indexed to release; rewrite only to drop older generations.
        if (!prior || prior.entries.length === entries.length) return;
      } else {
        existing.state = "released";
        existing.updated_at = updatedAt;
      }
    }
    const body: FinalizationPathIndexFile = {
      version: FINALIZATION_PATH_INDEX_VERSION,
      instance_id: input.instanceId,
      entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    };
    atomicWrite(file, `${JSON.stringify(body, null, 2)}\n`);
  });
  pruneFinalizationPathIndex(coordRoot, { now: input.now });
}

/** The current file for a write, or null when absent. Never replaces an unreadable one. */
function readForWrite(file: string, instanceId: string): FinalizationPathIndexFile | null {
  if (!existsSync(file)) return null;
  const prior = parseIndex(readFileSync(file, "utf8"), instanceId);
  if (!prior) throw new FinalizationPathIndexUnreadableError(file);
  return prior;
}

/** Remove one instance's index file, as session-end cleanup does for sibling state. */
export function removeFinalizationPathIndex(coordRoot: string, instanceId: string): boolean {
  const file = indexFile(coordRoot, instanceId);
  if (!existsSync(file)) return false;
  try {
    withIndexLock(file, () => unlinkSync(file));
    return true;
  } catch {
    return false;
  }
}

/** Delete index files nobody has written for `maxAgeMs`. Best effort. */
export function pruneFinalizationPathIndex(
  coordRoot: string,
  options: { maxAgeMs?: number; now?: Date } = {},
): string[] {
  const dir = finalizationPathIndexDir(coordRoot);
  const maxAge = options.maxAgeMs ?? FINALIZATION_PATH_INDEX_MAX_AGE_MS;
  const now = (options.now ?? new Date()).getTime();
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs <= maxAge) continue;
      unlinkSync(path);
      removed.push(name);
    } catch {
      /* raced with another writer or cleanup */
    }
  }
  return removed;
}
