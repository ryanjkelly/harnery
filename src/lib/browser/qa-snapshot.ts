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

import { randomUUID } from "node:crypto";
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
import {
  PAGE_REVIEW_DECISIONS_SCHEMA,
  type PageReviewDecisionSlot,
  type PageReviewNativeEvidence,
} from "./page-review-contracts.js";
import { machineFindingKey, validateNativeEvidence } from "./page-review-evidence.js";
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
  tileEvidence?: PageReviewNativeEvidence;
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

/** Serialize both owned slots across processes. A stuck writer fails closed. */
function withStoreLock<T>(dir: string, operation: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = resolve(dir, ".write-lock");
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error(`Snapshot writer lock busy: ${dir}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function validateDecisionSlot(
  target: string,
  context: QaContext,
  slot: PageReviewDecisionSlot,
): void {
  const only = (value: object, keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  if (
    slot.schema !== PAGE_REVIEW_DECISIONS_SCHEMA ||
    slot.complete !== true ||
    slot.target !== target ||
    slot.context.viewport !== context.viewport ||
    slot.context.theme !== context.theme ||
    slot.context.state !== context.state ||
    slot.context.critique_contract_version !== 2 ||
    ![slot.context.viewport_width, slot.context.viewport_height, slot.context.dpr].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    !/^[a-f0-9]{64}$/.test(slot.context.rubric_digest) ||
    !slot.context.recipe_version ||
    !only(slot, [
      "schema",
      "complete",
      "target",
      "context",
      "source_run",
      "source_revision",
      "reviewer",
      "reviewed_at",
      "decisions",
    ]) ||
    !only(slot.context, [
      "viewport",
      "viewport_width",
      "viewport_height",
      "theme",
      "state",
      "dpr",
      "recipe_version",
      "rubric_digest",
      "critique_contract_version",
    ]) ||
    !slot.reviewer?.trim() ||
    !Number.isFinite(Date.parse(slot.reviewed_at)) ||
    !slot.source_run ||
    !Array.isArray(slot.decisions)
  )
    throw new Error("Invalid durable review decision slot");
  const keys = new Set<string>();
  for (const decision of slot.decisions) {
    if (
      !decision.reviewer?.trim() ||
      !Number.isFinite(Date.parse(decision.at)) ||
      keys.has(decision.finding_key) ||
      !/^[a-f0-9]{64}$/.test(decision.tile_pixel_digest) ||
      !only(decision, [
        "finding_key",
        "tile_pixel_digest",
        "rect",
        "finding",
        "disposition",
        "reviewer",
        "at",
        "note",
      ]) ||
      !only(decision.finding, ["severity", "category", "description"]) ||
      !only(decision.rect, ["x", "y", "width", "height"]) ||
      ![decision.rect.x, decision.rect.y, decision.rect.width, decision.rect.height].every(
        Number.isInteger,
      ) ||
      decision.rect.x < 0 ||
      decision.rect.y < 0 ||
      decision.rect.width < 1 ||
      decision.rect.height < 1 ||
      !["artifact", "not-a-defect", "confirmed", "duplicate-of-gate"].includes(
        decision.disposition,
      ) ||
      decision.finding.category === "provider-error" ||
      machineFindingKey(
        slot.context,
        { rect: decision.rect, pixel_digest: decision.tile_pixel_digest },
        decision.finding,
      ) !== decision.finding_key
    ) {
      throw new Error("Invalid durable review finding identity");
    }
    keys.add(decision.finding_key);
  }
}

export function loadReviewDecisions(
  target: string,
  context: QaContext,
  opts: QaSnapshotStoreOptions = {},
): PageReviewDecisionSlot | null {
  const dir = snapshotDir(target, context, opts);
  if (!existsSync(dir)) return null;
  try {
    return withStoreLock(dir, () => {
      const slot = JSON.parse(
        readFileSync(resolve(dir, "review-decisions.json"), "utf8"),
      ) as PageReviewDecisionSlot;
      validateDecisionSlot(target, context, slot);
      return slot;
    });
  } catch {
    return null;
  }
}

/** Decisions contain text and digests only; replacing a baseline cannot touch this slot. */
export function saveReviewDecisions(
  target: string,
  context: QaContext,
  slot: PageReviewDecisionSlot,
  opts: QaSnapshotStoreOptions = {},
): void {
  validateDecisionSlot(target, context, slot);
  const dir = snapshotDir(target, context, opts);
  withStoreLock(dir, () => {
    const path = resolve(dir, "review-decisions.json");
    const temp = `${path}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temp, `${JSON.stringify(slot)}\n`);
      renameSync(temp, path);
    } finally {
      rmSync(temp, { force: true });
    }
  });
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
    tileEvidence?: PageReviewNativeEvidence;
  },
  opts: QaSnapshotStoreOptions = {},
): StoredQaSnapshot {
  const container = snapshotDir(target, context, opts);
  return withStoreLock(container, () => {
    const dir = resolve(container, "baseline");
    const staging = `${dir}.tmp-${randomUUID()}`;
    const previous = `${dir}.previous`;
    if (content.tileEvidence && content.screenshotPng)
      throw new Error("A pack native-tile baseline must not retain a full-page image");
    if (content.tileEvidence && !validateNativeEvidence(content.tileEvidence))
      throw new Error("Invalid native tile baseline evidence");
    mkdirSync(staging, { recursive: true });
    try {
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
      if (content.tileEvidence) {
        const tiles = content.tileEvidence.tiles.map(({ png, ...tile }, i) => {
          const file = `tile-${i}.png`;
          writeFileSync(resolve(staging, file), png);
          return { ...tile, file };
        });
        writeFileSync(
          resolve(staging, "native-evidence.json"),
          JSON.stringify({ ...content.tileEvidence, tiles }),
        );
      }
      // Recovery of a writer interrupted after moving its old baseline.
      if (!existsSync(dir) && existsSync(previous)) renameSync(previous, dir);
      rmSync(previous, { recursive: true, force: true });
      if (existsSync(dir)) renameSync(dir, previous);
      try {
        renameSync(staging, dir);
      } catch (error) {
        if (existsSync(previous)) renameSync(previous, dir);
        throw error;
      }
      rmSync(previous, { recursive: true, force: true });
      // Remove superseded legacy baseline files, never the independent decision slot.
      for (const name of [
        "signature.json",
        "dom.html",
        "screenshot.png",
        "critique.json",
        "native-evidence.json",
      ]) {
        rmSync(resolve(container, name), { force: true });
      }
      return {
        signature: content.signature,
        path: dir,
        ...(content.domHtml !== undefined ? { domHtmlPath: resolve(dir, "dom.html") } : {}),
        ...(content.screenshotPng !== undefined
          ? { screenshotPath: resolve(dir, "screenshot.png") }
          : {}),
        ...(content.critique ? { critique: content.critique } : {}),
        ...(content.tileEvidence ? { tileEvidence: content.tileEvidence } : {}),
      };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  });
}

/** Load the persisted snapshot for a target + context, or null. A corrupt
 * signature file returns null (and the caller re-acquires a baseline) rather
 * than throwing — a bad cache entry must never block QA. */
export function loadQaSnapshot(
  target: string,
  context: QaContext,
  opts: QaSnapshotStoreOptions = {},
): StoredQaSnapshot | null {
  const container = snapshotDir(target, context, opts);
  if (!existsSync(container)) return null;
  try {
    return withStoreLock(container, () => {
      const baseline = resolve(container, "baseline");
      const dir = existsSync(baseline)
        ? baseline
        : existsSync(`${baseline}.previous`)
          ? `${baseline}.previous`
          : container;
      const sigPath = resolve(dir, "signature.json");
      if (!existsSync(sigPath)) return null;
      try {
        const signature = JSON.parse(readFileSync(sigPath, "utf8")) as QaSignature;
        if (
          !signature ||
          !Array.isArray(signature.nodes) ||
          !Array.isArray(signature.stylesheets)
        ) {
          return null;
        }
        const domHtmlPath = resolve(dir, "dom.html");
        const screenshotPath = resolve(dir, "screenshot.png");
        const critiquePath = resolve(dir, "critique.json");
        let critique: PersistedCritique | undefined;
        let tileEvidence: PageReviewNativeEvidence | undefined;
        try {
          const raw = JSON.parse(readFileSync(resolve(dir, "native-evidence.json"), "utf8"));
          const candidate = {
            ...raw,
            tiles: raw.tiles.map((tile: { file: string }) => {
              if (!/^tile-\d+\.png$/.test(tile.file)) throw new Error("Invalid native tile path");
              return { ...tile, png: readFileSync(resolve(dir, tile.file)) };
            }),
          } as PageReviewNativeEvidence;
          if (validateNativeEvidence(candidate)) tileEvidence = candidate;
        } catch {
          /* Missing or corrupt evidence is a cache miss. */
        }
        if (existsSync(critiquePath)) {
          try {
            const parsed = JSON.parse(readFileSync(critiquePath, "utf8")) as PersistedCritique;
            if (
              parsed &&
              typeof parsed.contract_version === "number" &&
              Array.isArray(parsed.tiles)
            ) {
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
          ...(tileEvidence ? { tileEvidence } : {}),
        };
      } catch {
        return null;
      }
    });
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
