// Persisted QA snapshots: the baseline source that makes repeat QA cheap.
//
// Every passing QA run persists its final page signature (and optionally the
// serialized DOM + full-page screenshot) per render context. The next run
// inherits its baseline for free instead of re-rendering production or a git
// revision. Resolution order (the plan's 2.6):
//   1. persisted QA snapshot   (this store)
//   2. production render       (caller-supplied fallback)
//   3. baseline-revision render (caller-supplied fallback, from a worktree)
//   4. none                    → classification is `unknown`, never text-only
//
// Storage is content-under-a-key, like visual-diff baselines: a directory per
// target, a subdirectory per context, atomic writes (tmp + rename) so a
// crashed writer never leaves a half-baseline the next run would trust.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fnv1a32, type QaContext, type QaSignature } from "./qa-plan.js";
import type { PersistedCritique } from "./qa-reuse.js";

const SNAPSHOT_DIR = resolve(homedir(), ".cache", "harnery", "qa-snapshots");

export interface QaSnapshotStoreOptions {
  /** Override the store root (tests, host-managed cache locations). */
  root?: string;
}

export interface StoredQaSnapshot {
  signature: QaSignature;
  /** Directory holding this snapshot's files. */
  path: string;
  domHtmlPath?: string;
  screenshotPath?: string;
  /** Critique results persisted with the snapshot (full-coverage runs only) —
   * what the band-diff reuse layer replays for provably-unchanged regions. */
  critique?: PersistedCritique;
}

/** Filesystem-safe key for a target URL/file + render context. The digest
 * disambiguates targets whose sanitized slugs collide. */
export function qaSnapshotKey(target: string): string {
  const source = target.replace(/^[a-z]+:\/\//i, "");
  let slug = "";
  let separatorPending = false;
  for (let index = 0; index < source.length && slug.length < 80; index++) {
    const code = source.charCodeAt(index);
    const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    if (alpha || digit) {
      if (separatorPending && slug.length > 0 && slug.length < 80) slug += "-";
      if (slug.length < 80) slug += source[index];
      separatorPending = false;
    } else if (slug.length > 0) {
      separatorPending = true;
    }
  }
  return `${slug || "target"}-${fnv1a32(target).slice(0, 8)}`;
}

function contextDirName(context: QaContext): string {
  const clean = (part: string) => part.replace(/[^a-zA-Z0-9_.]+/g, "-");
  return `${clean(context.viewport)}-${clean(context.theme)}-${clean(context.state)}`;
}

function snapshotDir(target: string, context: QaContext, opts: QaSnapshotStoreOptions): string {
  return resolve(opts.root ?? SNAPSHOT_DIR, qaSnapshotKey(target), contextDirName(context));
}

/**
 * Persist a QA snapshot atomically. The whole context directory is staged as
 * `<dir>.tmp-<pid>` and renamed into place, replacing any prior snapshot for
 * the same target + context — a reader never observes a partial write.
 */
export function saveQaSnapshot(
  target: string,
  context: QaContext,
  content: {
    signature: QaSignature;
    domHtml?: string;
    screenshotPng?: Buffer;
    critique?: PersistedCritique;
  },
  opts: QaSnapshotStoreOptions = {},
): StoredQaSnapshot {
  const dir = snapshotDir(target, context, opts);
  const staging = `${dir}.tmp-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  writeFileSync(resolve(staging, "signature.json"), `${JSON.stringify(content.signature)}\n`);
  if (content.domHtml !== undefined) {
    writeFileSync(resolve(staging, "dom.html"), content.domHtml);
  }
  if (content.screenshotPng !== undefined) {
    writeFileSync(resolve(staging, "screenshot.png"), content.screenshotPng);
  }
  if (content.critique !== undefined) {
    writeFileSync(resolve(staging, "critique.json"), `${JSON.stringify(content.critique)}\n`);
  }
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  return {
    signature: content.signature,
    path: dir,
    ...(content.domHtml !== undefined ? { domHtmlPath: resolve(dir, "dom.html") } : {}),
    ...(content.screenshotPng !== undefined
      ? { screenshotPath: resolve(dir, "screenshot.png") }
      : {}),
  };
}

/** Load the persisted snapshot for a target + context, or null. A corrupt
 * signature file returns null (and the caller re-acquires a baseline) rather
 * than throwing — a bad cache entry must never block QA. */
export function loadQaSnapshot(
  target: string,
  context: QaContext,
  opts: QaSnapshotStoreOptions = {},
): StoredQaSnapshot | null {
  const dir = snapshotDir(target, context, opts);
  const sigPath = resolve(dir, "signature.json");
  if (!existsSync(sigPath)) return null;
  try {
    const signature = JSON.parse(readFileSync(sigPath, "utf8")) as QaSignature;
    if (!signature || !Array.isArray(signature.nodes) || !Array.isArray(signature.stylesheets)) {
      return null;
    }
    const domHtmlPath = resolve(dir, "dom.html");
    const screenshotPath = resolve(dir, "screenshot.png");
    const critiquePath = resolve(dir, "critique.json");
    let critique: PersistedCritique | undefined;
    if (existsSync(critiquePath)) {
      try {
        const parsed = JSON.parse(readFileSync(critiquePath, "utf8")) as PersistedCritique;
        if (parsed && typeof parsed.contract_version === "number" && Array.isArray(parsed.tiles)) {
          critique = parsed;
        }
      } catch {
        // corrupt critique.json degrades to a reuse miss, never an error
      }
    }
    return {
      signature,
      path: dir,
      ...(existsSync(domHtmlPath) ? { domHtmlPath } : {}),
      ...(existsSync(screenshotPath) ? { screenshotPath } : {}),
      ...(critique ? { critique } : {}),
    };
  } catch {
    return null;
  }
}

/** List targets with at least one persisted snapshot (store maintenance). */
export function listQaSnapshotTargets(opts: QaSnapshotStoreOptions = {}): string[] {
  const root = opts.root ?? SNAPSHOT_DIR;
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root)
      .filter((name) => !name.includes(".tmp-"))
      .sort();
  } catch {
    return [];
  }
}

export interface ResolvedQaBaseline {
  /** `qa-snapshot:<capturedAt>` | `production-render:<capturedAt>` |
   * `revision-render:<label>` | `none` — recorded in the manifest so a
   * reviewer can judge staleness. */
  source: string;
  signature: QaSignature | null;
}

/**
 * Walk the baseline resolution order with caller-supplied fallbacks. Pure
 * orchestration: rendering lives in the caller (production URLs and git
 * worktrees are its business), this just encodes the order and the source
 * labeling. A fallback that throws or returns null falls through to the next
 * rung; exhausting all rungs returns `{ source: "none", signature: null }`,
 * which classifies as `unknown` — never silently text-only.
 */
export async function resolveQaBaseline(opts: {
  target: string;
  context: QaContext;
  store?: QaSnapshotStoreOptions;
  renderProduction?: () => Promise<QaSignature | null>;
  renderRevision?: { label: string; render: () => Promise<QaSignature | null> };
}): Promise<ResolvedQaBaseline> {
  const stored = loadQaSnapshot(opts.target, opts.context, opts.store ?? {});
  if (stored) {
    return { source: `qa-snapshot:${stored.signature.capturedAt}`, signature: stored.signature };
  }
  if (opts.renderProduction) {
    try {
      const signature = await opts.renderProduction();
      if (signature) return { source: `production-render:${signature.capturedAt}`, signature };
    } catch {
      // fall through — an unreachable production URL is not a verdict
    }
  }
  if (opts.renderRevision) {
    try {
      const signature = await opts.renderRevision.render();
      if (signature) {
        return { source: `revision-render:${opts.renderRevision.label}`, signature };
      }
    } catch {
      // fall through
    }
  }
  return { source: "none", signature: null };
}

export { SNAPSHOT_DIR as QA_SNAPSHOT_DIR };
