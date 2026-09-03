// Judge a page review pack: one bounded pool of vision calls over every tile
// of every context, read from disk, with no browser open. This is the second
// half of the capture-then-judge split; `page-review-pack.ts` owns the first.
//
// Reuse: when a persisted QA snapshot exists for a context, the band-diff
// planner compares the pack's own full-page screenshot with the baseline and
// skips tiles whose pixels provably did not change and carried no baseline
// finding (false reviews are allowed, false passes never).
//
// Toolkit tier: this module must not import src/core (layering check).

import type { CritiqueFinding, CritiqueProvider, CritiqueTile } from "./critique.js";
import type { PageReviewNativeEvidence } from "./page-review-contracts.js";
import {
  buildPackNativeEvidence,
  PAGE_REVIEW_CRITIQUE_SCHEMA,
  planNativeTileReuse,
} from "./page-review-evidence.js";
import {
  listPackContexts,
  type PageReviewContextRecord,
  type PageReviewCritiqueRecord,
  readPackContext,
  readPackTiles,
} from "./page-review-pack.js";
import type { QaContext } from "./qa-plan.js";
import type { CritiqueReusePlan } from "./qa-reuse.js";
import { loadQaSnapshot, type QaSnapshotStoreOptions } from "./qa-snapshot.js";

export interface JudgePageReviewPackOptions {
  packDir: string;
  /** Host-injected vision call. Absent: every context reports `skipped`. */
  provider: CritiqueProvider | undefined;
  rubric: string;
  /** Vision calls in flight across the whole pack. Default: the provider's
   * own concurrency, then 4. */
  concurrency?: number;
  /** Subset of context ids to judge (default: every context in the pack). */
  contextIds?: string[];
  /** Band-diff reuse against persisted snapshots keyed by `target`. */
  reuse?: {
    target: string;
    store?: QaSnapshotStoreOptions;
    mismatchThreshold?: number;
  };
  /** Absolute epoch-ms deadline. Workers stop claiming tiles once past it;
   * a context with unjudged tiles reports `incomplete`, never `pass`. */
  deadlineAt?: number;
  onLog?: (message: string) => void;
}

export interface JudgedContext extends PageReviewCritiqueRecord {
  record: PageReviewContextRecord;
  /** Tiles selected for review that the pool never reached (deadline). */
  tiles_unjudged: number;
  reuse?: Pick<
    CritiqueReusePlan,
    "tiles_total" | "tiles_reused" | "tiles_reviewed" | "invalidation" | "mismatch_threshold"
  >;
}

export interface JudgePageReviewPackResult {
  contexts: JudgedContext[];
  pool: { concurrency: number; wall_time_ms: number; provider: string };
  tiles_total: number;
  tiles_reviewed: number;
  tiles_reused: number;
  outcome: "pass" | "fail" | "skipped" | "incomplete";
  provider_meta?: Record<string, unknown>;
}

interface WorkItem {
  contextIndex: number;
  tile: CritiqueTile & { id: string };
  url: string;
  /** The rubric with this tile's position preamble in front of it. */
  rubric: string;
}

/**
 * Orientation the provider reads before the rubric: which band this tile is,
 * where it sits on the page, how much of it repeats a neighbour, whether it
 * touches the page top or bottom, and how it was captured. A tile edge that
 * continues in the next band is not a clipped element, and a fixed header at
 * the top of a scrolled-band capture is not a layout defect; the preamble
 * says so where the pixels cannot. Adds context only: the finding taxonomy
 * the rubric defines is unchanged. Empty for an unknown tile id.
 */
export function tileRubricPreamble(record: PageReviewContextRecord, tileId: string): string {
  const tile = record.tiles.find((entry) => entry.id === tileId);
  if (!tile) return "";
  const pageHeight = record.page.height;
  const top = tile.scrollY;
  const bottom = tile.scrollY + tile.height;
  const lines: string[] = [];
  if (tile.scope !== undefined) {
    lines.push(
      `Tile ${tile.id}: selector tile for ${tile.scope} (${tile.label}), ` +
        `document y ${top}-${bottom} px of a ${pageHeight} px tall page.`,
    );
  } else {
    const bands = record.tiles
      .filter((entry) => entry.scope === undefined)
      .sort((a, b) => a.scrollY - b.scrollY || a.index - b.index);
    const n = bands.findIndex((entry) => entry.id === tile.id);
    const capped = record.coverage.capped
      ? ` (the page has ${record.coverage.bands_total} bands; unselected bands are not in this pack)`
      : "";
    lines.push(
      `Tile ${tile.id}: band ${n + 1} of ${bands.length}${capped}, ` +
        `document y ${top}-${bottom} px of a ${pageHeight} px tall page.`,
    );
    const prev = bands[n - 1];
    const next = bands[n + 1];
    const overlaps: string[] = [];
    if (prev) {
      const above = Math.max(0, prev.scrollY + prev.height - top);
      overlaps.push(
        above > 0
          ? `its top ${above} px repeat the bottom of ${prev.id}`
          : prev.scrollY + prev.height === top
            ? `it starts where ${prev.id} ends, with no overlap`
            : `an unreviewed gap of ${top - prev.scrollY - prev.height} px separates it from ${prev.id}`,
      );
    }
    if (next) {
      const below = Math.max(0, bottom - next.scrollY);
      overlaps.push(
        below > 0
          ? `its bottom ${below} px repeat the top of ${next.id}`
          : bottom === next.scrollY
            ? `it ends where ${next.id} starts, with no overlap`
            : `an unreviewed gap of ${next.scrollY - bottom} px separates it from ${next.id}`,
      );
    }
    if (overlaps.length > 0) {
      const joined = overlaps.join("; ");
      lines.push(`${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`);
    }
  }
  const touchesTop = top <= 0;
  const touchesBottom = bottom >= pageHeight;
  if (touchesTop && touchesBottom) {
    lines.push("This tile covers the whole page height.");
  } else if (touchesTop) {
    lines.push(
      "This tile touches the page top; the capture continues below its bottom edge, which alone does not prove clipping.",
    );
  } else if (touchesBottom) {
    lines.push(
      "This tile touches the page bottom; the capture continues above its top edge, which alone does not prove clipping.",
    );
  } else {
    lines.push(
      "This tile is interior: the page continues beyond both edges. Use document positions to distinguish overlapping bands from unreviewed gaps.",
    );
  }
  const source = record.capture_fidelity?.source ?? "full-page";
  lines.push(
    source === "scrolled-bands"
      ? "Capture source: scrolled-bands (the viewport was scrolled to this band and clipped, because " +
          "the full-page screenshot disagreed with the viewport render). Fixed and sticky elements " +
          "are shown once, at their document position, as a full-page screenshot shows them; a " +
          "fixed bar that is absent from this band is therefore not a defect."
      : "Capture source: full-page (one full-page screenshot, cropped to this band).",
  );
  return lines.join(" ");
}

function providerLabel(meta: Record<string, unknown> | undefined, present: boolean): string {
  if (meta) {
    for (const key of ["provider", "active_harness", "route", "model"]) {
      const value = meta[key];
      if (typeof value === "string" && value.length > 0) return value;
      if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    }
  }
  return present ? "host" : "none";
}

/**
 * Judge every tile in the pack through one pool. Findings keep the tiler
 * index (`tile`) for compatibility with `CritiqueFinding` and add the pack's
 * stable `tile_id`. A provider throw on one tile becomes a `high`
 * `provider-error` finding for that tile; nothing else is affected.
 */
export async function judgePageReviewPack(
  options: JudgePageReviewPackOptions,
): Promise<JudgePageReviewPackResult> {
  const { packDir, provider, rubric } = options;
  const log = options.onLog ?? (() => {});
  const ids = options.contextIds ?? listPackContexts(packDir);
  const records = ids.map((id) => readPackContext(packDir, id));
  const started = Date.now();

  const perContext: Array<{
    record: PageReviewContextRecord;
    tiles: Array<CritiqueTile & { id: string }>;
    review: Array<CritiqueTile & { id: string }>;
    reuse?: CritiqueReusePlan;
    findings: Array<CritiqueFinding & { tile_id: string }>;
    evidence: PageReviewNativeEvidence;
    judged: Set<string>;
  }> = records.map((record) => {
    const tiles = readPackTiles(packDir, record);
    let review = tiles;
    let reuse: CritiqueReusePlan | undefined;
    const evidence = buildPackNativeEvidence(record, tiles, rubric);
    record.evidence_context = evidence.context;
    if (
      options.reuse &&
      provider &&
      record.scopes.length === 0 &&
      !record.capture_incomplete &&
      !record.coverage.capped
    ) {
      const context: QaContext = {
        viewport: record.viewport,
        theme: record.theme,
        state: record.state,
      };
      const stored = loadQaSnapshot(options.reuse.target, context, options.reuse.store ?? {});
      reuse = planNativeTileReuse({
        current: evidence,
        baseline: stored?.tileEvidence,
        critique: stored?.critique,
        tiles,
        ...(options.reuse.mismatchThreshold !== undefined
          ? { mismatchThreshold: options.reuse.mismatchThreshold }
          : {}),
      });
      review = tiles.filter((_, i) => !reuse?.decisions[i]?.reuse);
      log(
        `judge ${record.id}: ${reuse.tiles_reused}/${reuse.tiles_total} tiles reused (band-diff)` +
          (reuse.invalidation ? ` — ${reuse.invalidation}` : ""),
      );
    }
    return {
      record,
      tiles,
      review,
      evidence,
      ...(reuse ? { reuse } : {}),
      findings: [],
      judged: new Set(),
    };
  });

  const work: WorkItem[] = [];
  perContext.forEach((entry, contextIndex) => {
    for (const tile of entry.review) {
      const preamble = tileRubricPreamble(entry.record, tile.id);
      work.push({
        contextIndex,
        tile,
        url: entry.record.url,
        rubric: preamble ? `${preamble}\n\n${rubric}` : rubric,
      });
    }
  });

  let meta: Record<string, unknown> | undefined;
  let concurrency = 0;
  if (provider && work.length > 0) {
    concurrency = Math.max(
      1,
      Math.min(options.concurrency ?? provider.concurrency ?? 4, work.length),
    );
    log(`judge: ${work.length} tile(s) across ${records.length} context(s), pool ${concurrency}`);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) return;
        const i = cursor++;
        if (i >= work.length) return;
        const item = work[i] as WorkItem;
        const entry = perContext[item.contextIndex];
        if (!entry) continue;
        entry.judged.add(item.tile.id);
        try {
          const found = await provider({ url: item.url, rubric: item.rubric, tile: item.tile });
          for (const finding of found) {
            entry.findings.push({ ...finding, tile: item.tile.index, tile_id: item.tile.id });
          }
        } catch (err: unknown) {
          entry.findings.push({
            tile: item.tile.index,
            tile_id: item.tile.id,
            severity: "high",
            category: "provider-error",
            description: `critique provider failed on ${item.tile.label}: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    meta = provider.meta?.();
  } else if (provider) {
    meta = provider.meta?.();
  }

  const label = providerLabel(meta, Boolean(provider));
  const contexts: JudgedContext[] = perContext.map((entry) => {
    // Deterministic order: by tile id, then insertion.
    const findings = [...entry.findings].sort((a, b) => a.tile_id.localeCompare(b.tile_id));
    const unjudged = entry.review.filter((tile) => !entry.judged.has(tile.id)).length;
    const outcome: JudgedContext["outcome"] = !provider
      ? "skipped"
      : findings.some((f) => f.severity === "high")
        ? "fail"
        : unjudged > 0 || entry.record.capture_incomplete
          ? "incomplete"
          : "pass";
    return {
      context_id: entry.record.id,
      provider: provider ? label : "none",
      tiles_total: entry.tiles.length,
      tiles_reviewed: entry.review.length - unjudged,
      tiles_unjudged: unjudged,
      tiles_reused: entry.reuse?.tiles_reused ?? 0,
      outcome,
      findings,
      coverage: entry.record.coverage,
      ...(provider
        ? {}
        : {
            error:
              "no critiqueProvider injected by the host (see HarneryProgramContext.critiqueProvider)",
          }),
      record: entry.record,
      evidence: {
        schema: PAGE_REVIEW_CRITIQUE_SCHEMA,
        context: entry.evidence.context,
        tiles: entry.evidence.tiles.map(({ png: _png, ...tile }) => tile),
      },
      ...(entry.reuse
        ? {
            reuse: {
              tiles_total: entry.reuse.tiles_total,
              tiles_reused: entry.reuse.tiles_reused,
              tiles_reviewed: entry.reuse.tiles_reviewed,
              mismatch_threshold: entry.reuse.mismatch_threshold,
              ...(entry.reuse.invalidation ? { invalidation: entry.reuse.invalidation } : {}),
            },
          }
        : {}),
    };
  });

  const tilesTotal = contexts.reduce((sum, c) => sum + c.tiles_total, 0);
  const tilesReviewed = contexts.reduce((sum, c) => sum + c.tiles_reviewed, 0);
  const tilesReused = contexts.reduce((sum, c) => sum + c.tiles_reused, 0);
  const outcome: JudgePageReviewPackResult["outcome"] = !provider
    ? "skipped"
    : contexts.some((c) => c.outcome === "fail")
      ? "fail"
      : contexts.some((c) => c.outcome === "incomplete")
        ? "incomplete"
        : "pass";
  return {
    contexts,
    pool: { concurrency, wall_time_ms: Date.now() - started, provider: label },
    tiles_total: tilesTotal,
    tiles_reviewed: tilesReviewed,
    tiles_reused: tilesReused,
    outcome,
    ...(meta ? { provider_meta: meta } : {}),
  };
}

/** Strip the in-memory `record` so the result can be written into the pack. */
export function toCritiqueRecords(result: JudgePageReviewPackResult): PageReviewCritiqueRecord[] {
  return result.contexts.map(
    ({ record: _record, reuse: _reuse, tiles_unjudged: _unjudged, ...rest }) => rest,
  );
}
