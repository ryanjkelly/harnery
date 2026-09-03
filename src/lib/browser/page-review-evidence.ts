// Native pixels are the evidence. Overviews and PNG encodings are not identity.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { CritiqueFinding, CritiqueTile } from "./critique.js";
import {
  PAGE_REVIEW_DECISIONS_SCHEMA,
  PAGE_REVIEW_NATIVE_EVIDENCE_SCHEMA,
  type PageReviewDecisionSlot,
  type PageReviewEvidenceContext,
  type PageReviewNativeEvidence,
  type PageReviewNativeTile,
  type PageReviewRect,
} from "./page-review-contracts.js";
import {
  buildInspectionPlan,
  machineFindingTargets,
  type PageReviewContextRecord,
  type PageReviewCritiqueRecord,
  packPaths,
  readPackFindings,
  readPackManifest,
  readPackTiles,
  resolvePackVerdict,
  validateFindingsDocument,
} from "./page-review-pack.js";
import {
  type CritiqueReusePlan,
  DEFAULT_REUSE_MISMATCH_RATIO,
  type PersistedCritique,
} from "./qa-reuse.js";
import { type QaSnapshotStoreOptions, saveReviewDecisions } from "./qa-snapshot.js";

export const PAGE_REVIEW_CRITIQUE_CONTRACT_VERSION = 2;
export const PAGE_REVIEW_CRITIQUE_SCHEMA = "harnery-page-review-critique/v2";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const packRubricDigest = (rubric: string): string => hash(rubric);

export function machineEvidenceDigest(
  target: string,
  critique: PageReviewCritiqueRecord[] | null,
): string {
  return hash(
    JSON.stringify({
      target,
      contexts:
        critique?.map((row) => ({
          context_id: row.context_id,
          outcome: row.outcome,
          findings: row.findings,
          evidence: row.evidence ?? null,
          coverage: row.coverage,
        })) ?? null,
    }),
  );
}

export function nativePixelDigest(png: Buffer): string {
  return decodedPixelDigest(PNG.sync.read(png));
}

function decodedPixelDigest(decoded: PNG): string {
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(decoded.width, 0);
  dimensions.writeUInt32BE(decoded.height, 4);
  return createHash("sha256").update(dimensions).update(decoded.data).digest("hex");
}

export function evidenceContextKey(context: PageReviewEvidenceContext): string {
  return JSON.stringify([
    context.viewport,
    context.viewport_width,
    context.viewport_height,
    context.theme,
    context.state,
    context.dpr,
    context.recipe_version,
    context.rubric_digest,
    context.critique_contract_version,
  ]);
}

export function nativeRectKey(rect: PageReviewRect): string {
  return JSON.stringify([rect.x, rect.y, rect.width, rect.height]);
}

export function validateNativeEvidence(evidence: PageReviewNativeEvidence): boolean {
  try {
    const ctx = evidence.context;
    if (
      evidence.schema !== PAGE_REVIEW_NATIVE_EVIDENCE_SCHEMA ||
      ctx.critique_contract_version !== PAGE_REVIEW_CRITIQUE_CONTRACT_VERSION ||
      ![ctx.viewport_width, ctx.viewport_height, ctx.dpr].every(
        (n) => Number.isFinite(n) && n > 0,
      ) ||
      !ctx.recipe_version ||
      !ctx.rubric_digest ||
      !ctx.viewport ||
      !ctx.state ||
      !["light", "dark"].includes(ctx.theme) ||
      !Array.isArray(evidence.tiles)
    )
      return false;
    const ids = new Set<string>();
    return evidence.tiles.every((tile) => {
      if (!tile.tile_id || ids.has(tile.tile_id)) return false;
      ids.add(tile.tile_id);
      const { x, y, width, height } = tile.rect;
      if (
        ![x, y, width, height].every(Number.isInteger) ||
        x < 0 ||
        y < 0 ||
        width < 1 ||
        height < 1
      )
        return false;
      const decoded = PNG.sync.read(tile.png);
      return (
        decoded.width === width &&
        decoded.height === height &&
        decodedPixelDigest(decoded) === tile.pixel_digest
      );
    });
  } catch {
    return false;
  }
}

export function buildPackNativeEvidence(
  record: PageReviewContextRecord,
  tiles: Array<CritiqueTile & { id: string }>,
  rubric: string,
): PageReviewNativeEvidence {
  const evidence: PageReviewNativeEvidence = {
    schema: PAGE_REVIEW_NATIVE_EVIDENCE_SCHEMA,
    context: {
      viewport: record.viewport,
      viewport_width: record.viewport_size.width,
      viewport_height: record.viewport_size.height,
      theme: record.theme,
      state: record.state,
      dpr: record.dpr,
      recipe_version: `${record.recipe_version};source=${record.capture_fidelity?.source ?? "full-page"}`,
      rubric_digest: packRubricDigest(rubric),
      critique_contract_version: PAGE_REVIEW_CRITIQUE_CONTRACT_VERSION,
    },
    tiles: tiles.map((tile) => {
      const png = Buffer.from(tile.pngBase64, "base64");
      return {
        tile_id: tile.id,
        index: tile.index,
        label: tile.label,
        rect: { x: tile.x ?? 0, y: tile.scrollY, width: tile.width, height: tile.height },
        pixel_digest: nativePixelDigest(png),
        png,
      };
    }),
  };
  if (!validateNativeEvidence(evidence))
    throw new Error("Native tile evidence has invalid geometry or pixels; recapture this context.");
  return evidence;
}

/** A baseline finding forces review even when it was previously dismissed. */
export function planNativeTileReuse(input: {
  current: PageReviewNativeEvidence;
  baseline?: PageReviewNativeEvidence;
  critique?: PersistedCritique;
  tiles: Array<CritiqueTile & { id: string }>;
  mismatchThreshold?: number;
}): CritiqueReusePlan {
  const threshold = input.mismatchThreshold ?? DEFAULT_REUSE_MISMATCH_RATIO;
  const { current, baseline, critique } = input;
  const validCritique =
    critique &&
    ["pass", "fail"].includes(critique.outcome) &&
    Array.isArray(critique.findings) &&
    Array.isArray(critique.tiles) &&
    critique.findings.every(
      (f) =>
        Number.isInteger(f.tile) &&
        typeof f.description === "string" &&
        typeof f.category === "string" &&
        ["high", "medium", "low"].includes(f.severity),
    );
  const invalidation =
    !baseline || !critique
      ? "native-evidence-missing"
      : !validCritique
        ? "native-critique-invalid"
        : !validateNativeEvidence(baseline) || !validateNativeEvidence(current)
          ? "native-evidence-invalid"
          : critique.contract_version !== PAGE_REVIEW_CRITIQUE_CONTRACT_VERSION ||
              critique.rubric_digest !== current.context.rubric_digest ||
              evidenceContextKey(current.context) !== evidenceContextKey(baseline.context)
            ? "native-evidence-contract-changed"
            : undefined;
  const decisions = input.tiles.map((tile) => {
    const cur = current.tiles.find((t) => t.tile_id === tile.id);
    const prior =
      cur && baseline?.tiles.find((t) => nativeRectKey(t.rect) === nativeRectKey(cur.rect));
    let reason = invalidation;
    let ratio: number | undefined;
    if (!reason && (!cur || !prior)) reason = "native-tile-missing";
    if (!reason && prior && critique) {
      const affected = critique.findings.some((finding) => {
        const found = baseline?.tiles.filter((t) => t.index === finding.tile);
        if (!found?.length) return true;
        return found.some(
          (t) =>
            t.rect.x < prior.rect.x + prior.rect.width &&
            t.rect.x + t.rect.width > prior.rect.x &&
            t.rect.y < prior.rect.y + prior.rect.height &&
            t.rect.y + t.rect.height > prior.rect.y,
        );
      });
      if (affected) reason = "baseline-finding";
    }
    if (!reason && cur && prior) {
      const a = PNG.sync.read(prior.png);
      const b = PNG.sync.read(cur.png);
      ratio =
        pixelmatch(a.data, b.data, undefined, a.width, a.height, {
          threshold: 0.1,
          includeAA: false,
        }) /
        (a.width * a.height);
      if (ratio > threshold) reason = "pixels-changed";
    }
    return {
      index: tile.index,
      label: tile.label,
      reuse: !reason,
      reason: reason ?? "unchanged-clean-native-tile",
      ...(ratio === undefined ? {} : { mismatch_ratio: ratio }),
    };
  });
  const review = input.tiles.filter((_, i) => !decisions[i]?.reuse);
  return {
    mode: "band-diff",
    review,
    decisions,
    tiles_total: input.tiles.length,
    tiles_reviewed: review.length,
    tiles_reused: input.tiles.length - review.length,
    provider_calls_avoided: input.tiles.length - review.length,
    mismatch_threshold: threshold,
    ...(invalidation ? { invalidation } : {}),
  };
}

export function machineFindingKey(
  context: PageReviewEvidenceContext,
  tile: Pick<PageReviewNativeTile, "rect" | "pixel_digest">,
  finding: Pick<CritiqueFinding, "severity" | "category" | "description">,
): string {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  return hash(
    JSON.stringify([
      evidenceContextKey(context),
      nativeRectKey(tile.rect),
      tile.pixel_digest,
      normalize(finding.severity),
      normalize(finding.category),
      normalize(finding.description),
    ]),
  );
}

export function applyPackReviewDecisions(input: {
  target: string;
  evidence: PageReviewNativeEvidence;
  findings: Array<CritiqueFinding & { tile_id: string }>;
  slot: PageReviewDecisionSlot | null;
  enabled: boolean;
}): {
  findings: Array<CritiqueFinding & { tile_id: string }>;
  applied: Array<{ finding_key: string; target: string; disposition: "artifact" | "not-a-defect" }>;
} {
  const applied: Array<{
    finding_key: string;
    target: string;
    disposition: "artifact" | "not-a-defect";
  }> = [];
  const { slot, evidence } = input;
  if (
    !input.enabled ||
    !slot?.complete ||
    slot.target !== input.target ||
    evidenceContextKey(slot.context) !== evidenceContextKey(evidence.context) ||
    !validateNativeEvidence(evidence)
  )
    return { findings: [...input.findings], applied };
  const ordinals = new Map<string, number>();
  const findings = input.findings.filter((finding) => {
    const ordinal = ordinals.get(finding.tile_id) ?? 0;
    ordinals.set(finding.tile_id, ordinal + 1);
    if (finding.category === "provider-error") return true;
    const tile = evidence.tiles.find((t) => t.tile_id === finding.tile_id);
    if (!tile) return true;
    const key = machineFindingKey(evidence.context, tile, finding);
    const decision = slot.decisions.find(
      (d) =>
        d.finding_key === key &&
        d.tile_pixel_digest === tile.pixel_digest &&
        nativeRectKey(d.rect) === nativeRectKey(tile.rect) &&
        machineFindingKey(
          slot.context,
          { rect: d.rect, pixel_digest: d.tile_pixel_digest },
          d.finding,
        ) === key,
    );
    if (
      !decision ||
      (decision.disposition !== "artifact" && decision.disposition !== "not-a-defect")
    )
      return true;
    applied.push({
      finding_key: key,
      target: `${finding.tile_id}#${ordinal}`,
      disposition: decision.disposition,
    });
    return false;
  });
  return { findings, applied };
}

/** Validate the complete submission and all native bindings before writing any slot. */
export function persistPackReviewDecisions(
  packDir: string,
  store: QaSnapshotStoreOptions = {},
): number {
  const manifest = readPackManifest(packDir);
  const doc = readPackFindings(packDir);
  const errors = validateFindingsDocument(doc);
  if (errors.length) throw new Error(`Invalid findings document: ${errors.join("; ")}`);
  if (doc.machine_evidence_digest !== machineEvidenceDigest(manifest.target, manifest.critique)) {
    throw new Error(
      "Reviewer submission belongs to different machine evidence; review the current findings again",
    );
  }
  if (doc.target !== manifest.target || !doc.reviewer?.trim() || !doc.reviewed_at)
    throw new Error("Review target or reviewer identity is missing or mismatched");
  // Recompute required coverage from machine evidence, rather than trusting an edited plan.
  const plan = buildInspectionPlan(manifest.contexts, manifest.critique, manifest.gates);
  const verdict = resolvePackVerdict(manifest, plan, doc);
  if (
    !manifest.critique?.length ||
    verdict.uncovered_primary_tiles.length ||
    verdict.primary_tiles_total === 0 ||
    doc.delegated_reviews.some(
      (r) => r.status !== "complete" || r.completed_tiles.length !== r.assigned_tiles.length,
    ) ||
    manifest.contexts.some(
      (c) =>
        c.capture_incomplete ||
        c.coverage.capped ||
        c.coverage.reviewed_height_px < c.coverage.page_height_px ||
        c.allocation_coverage?.omitted_scopes.length ||
        c.allocation_coverage?.uncovered_intervals.length,
    ) ||
    manifest.critique.some(
      (c) =>
        c.outcome === "incomplete" ||
        c.outcome === "skipped" ||
        c.tiles_reviewed + c.tiles_reused !== c.tiles_total,
    )
  ) {
    throw new Error(
      "Durable decisions require complete delegated review and complete native capture/judging",
    );
  }
  const machineFile = JSON.parse(readFileSync(packPaths(packDir).critique, "utf8"));
  if (
    machineFile.schema !== PAGE_REVIEW_CRITIQUE_SCHEMA ||
    JSON.stringify(machineFile.contexts) !== JSON.stringify(manifest.critique)
  )
    throw new Error("Machine critique binding mismatch; recapture and judge this pack");
  const targets = machineFindingTargets(manifest.critique);
  if (verdict.unmatched_dispositions.length)
    throw new Error("Disposition names an absent machine finding");
  const primary = new Set(
    plan.contexts.flatMap((c) => c.primary_tiles.map((t) => `${c.context_id}/${t.id}`)),
  );
  if (doc.delegated_reviews.some((r) => r.assigned_tiles.some((t) => !primary.has(t))))
    throw new Error("Delegated review refers to an unknown primary tile");
  for (const finding of doc.findings) {
    const ctx = manifest.contexts.find((c) => c.id === finding.context_id);
    if (
      !ctx ||
      finding.evidence.some(
        (ref) =>
          !ctx.tiles.some((t) => ref === t.id || ref === t.file || ref === `${ctx.id}/${t.id}`),
      )
    )
      throw new Error("Reviewer finding has an invalid evidence binding");
  }
  const slots = manifest.contexts.map((record): PageReviewDecisionSlot => {
    const row = manifest.critique?.find((c) => c.context_id === record.id);
    if (!row?.evidence || row.evidence.schema !== PAGE_REVIEW_CRITIQUE_SCHEMA)
      throw new Error("Missing v2 machine evidence; rejudge this pack");
    const tiles = readPackTiles(packDir, record);
    const evidence = buildPackNativeEvidence(record, tiles, "");
    evidence.context.rubric_digest = row.evidence.context.rubric_digest;
    if (
      evidenceContextKey(evidence.context) !== evidenceContextKey(row.evidence.context) ||
      row.evidence.tiles.length !== evidence.tiles.length ||
      row.evidence.tiles.some(
        (tile) =>
          !evidence.tiles.some(
            (cur) =>
              cur.tile_id === tile.tile_id &&
              cur.pixel_digest === tile.pixel_digest &&
              nativeRectKey(cur.rect) === nativeRectKey(tile.rect),
          ),
      )
    ) {
      throw new Error("Native tile binding changed after judging; recapture and rejudge");
    }
    if (
      row.findings.some(
        (f) => !evidence.tiles.some((tile) => tile.tile_id === f.tile_id && tile.index === f.tile),
      )
    )
      throw new Error("Machine finding names an absent native tile");
    const decisions = new Map<string, PageReviewDecisionSlot["decisions"][number]>();
    for (const disposition of doc.dispositions ?? []) {
      const finding = targets.get(disposition.target);
      if (!finding || finding.context_id !== record.id) continue;
      if (finding.category === "provider-error")
        throw new Error("Provider errors cannot receive durable dispositions");
      const tile = evidence.tiles.find((t) => t.tile_id === finding.tile_id);
      if (!tile) throw new Error("Disposition tile binding is absent");
      const key = machineFindingKey(evidence.context, tile, finding);
      decisions.set(key, {
        finding_key: key,
        tile_pixel_digest: tile.pixel_digest,
        rect: tile.rect,
        finding: {
          severity: finding.severity,
          category: finding.category,
          description: finding.description,
        },
        disposition: disposition.disposition,
        reviewer: disposition.by?.trim() || doc.reviewer!,
        at: disposition.at ?? doc.reviewed_at!,
        ...(disposition.note === undefined ? {} : { note: disposition.note }),
      });
    }
    return {
      schema: PAGE_REVIEW_DECISIONS_SCHEMA,
      target: manifest.target,
      context: evidence.context,
      source_run: manifest.created_at,
      source_revision: manifest.tested_revision ?? null,
      reviewer: doc.reviewer!,
      reviewed_at: doc.reviewed_at!,
      complete: true,
      decisions: [...decisions.values()],
    };
  });
  for (const slot of slots) saveReviewDecisions(manifest.target, slot.context, slot, store);
  return slots.length;
}
