// Shared capture, allocation, and native-evidence contracts. Toolkit-only:
// capture and storage implement these shapes without importing coordination.
import type { CritiqueCoverage, CritiqueFinding } from "./critique.js";

export const PAGE_REVIEW_CAPTURE_PLAN_SCHEMA = "harnery-page-review-capture-plan/v1";
export const PAGE_REVIEW_NATIVE_EVIDENCE_SCHEMA = "harnery-page-review-native-evidence/v2";
export const PAGE_REVIEW_DECISIONS_SCHEMA = "harnery-page-review-decisions/v1";
export const PAGE_REVIEW_DEFAULT_TILE_BUDGET = 96;
export const PAGE_REVIEW_MAX_TILE_BUDGET = 400;

/** Rectangles are native image pixels, never CSS pixels or overview pixels. */
export interface PageReviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageReviewCandidate {
  id: string;
  index: number;
  label: string;
  rect: PageReviewRect;
  scope?: string;
  gate_hits: Array<{ check_id: string; severity: "critical" | "high" | "medium" | "low" | "info" }>;
}

export interface PageReviewCapturePlan {
  schema: typeof PAGE_REVIEW_CAPTURE_PLAN_SCHEMA;
  context_id: string;
  viewport: string;
  viewport_width: number;
  viewport_height: number;
  theme: "light" | "dark";
  state: string;
  dpr: number;
  page_width: number;
  page_height: number;
  /** Stable content/geometry signature; excludes capture timestamps. */
  source_digest: string;
  recipe_version: string;
  required_scopes: string[];
  candidates: PageReviewCandidate[];
}

export interface PageReviewBudgetCoverage extends CritiqueCoverage {
  selected_rectangles: PageReviewRect[];
  reviewed_intervals: Array<{ start: number; end: number }>;
  uncovered_intervals: Array<{ start: number; end: number }>;
  omitted_gate_hits: string[];
  omitted_scopes: string[];
}

export interface PageReviewContextAllocation {
  context_id: string;
  plan: PageReviewCapturePlan;
  selected_ids: string[];
  ceiling: number;
  omitted_candidates: Array<{ id: string; reason: "budget" | "ceiling" }>;
  coverage: PageReviewBudgetCoverage;
}

export interface PageReviewTileBudgetAllocation {
  budget: number;
  used: number;
  contexts: PageReviewContextAllocation[];
}

/** Pixel identity is meaningful only within an identical rendering contract. */
export interface PageReviewEvidenceContext {
  viewport: string;
  viewport_width: number;
  viewport_height: number;
  theme: "light" | "dark";
  state: string;
  dpr: number;
  recipe_version: string;
  rubric_digest: string;
  critique_contract_version: number;
}

/** In-memory form. The snapshot store writes PNGs separately from metadata. */
export interface PageReviewNativeTile {
  tile_id: string;
  index: number;
  label: string;
  rect: PageReviewRect;
  pixel_digest: string;
  png: Buffer;
}

export interface PageReviewNativeEvidence {
  schema: typeof PAGE_REVIEW_NATIVE_EVIDENCE_SCHEMA;
  context: PageReviewEvidenceContext;
  tiles: PageReviewNativeTile[];
}

export interface PageReviewDurableDecision {
  finding_key: string;
  tile_pixel_digest: string;
  rect: PageReviewRect;
  finding: Pick<CritiqueFinding, "severity" | "category" | "description">;
  disposition: "artifact" | "not-a-defect" | "confirmed" | "duplicate-of-gate";
  reviewer: string;
  at: string;
  note?: string;
}

/** Stored independently of baseline replacement and expiring pack directories. */
export interface PageReviewDecisionSlot {
  schema: typeof PAGE_REVIEW_DECISIONS_SCHEMA;
  target: string;
  context: PageReviewEvidenceContext;
  source_run: string;
  source_revision: string | null;
  reviewer: string;
  reviewed_at: string;
  complete: true;
  decisions: PageReviewDurableDecision[];
}
