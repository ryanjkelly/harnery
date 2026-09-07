import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  allocateTileBudget,
  capturePlanDigest,
  validatePageReviewAllocation,
} from "./page-review-budget.ts";
import type {
  PageReviewCapturePlan,
  PageReviewContextAllocation,
} from "./page-review-contracts.ts";
import { packPaths } from "./page-review-pack.ts";

/** Publish a complete context atomically; failed writes stay outside discoverable contexts. */
export function writeCaptureTransaction<T>(
  packDir: string,
  contextId: string,
  write: (stage: string) => T,
): T {
  mkdirSync(packDir, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(packDir, ".pending-capture-"));
  try {
    const result = write(stage);
    const destination = packPaths(packDir).contextDir(contextId);
    mkdirSync(dirname(destination), { recursive: true });
    if (existsSync(destination))
      throw new Error("Capture context already exists; refusing to replace prior evidence.");
    renameSync(packPaths(stage).contextDir(contextId), destination);
    rmSync(stage, { recursive: true });
    return result;
  } catch (error) {
    if (error instanceof Error) error.message += ` Incomplete capture retained at ${stage}.`;
    throw error;
  }
}

/** A preliminary allocation reserves pixels; it never supplies current source evidence. */
export function allocateCaptureReservation(
  reservation: PageReviewContextAllocation,
  current: PageReviewCapturePlan,
): PageReviewContextAllocation {
  validatePageReviewAllocation(reservation, reservation.plan);
  for (const key of [
    "context_id",
    "viewport",
    "viewport_width",
    "viewport_height",
    "theme",
    "state",
    "dpr",
    "recipe_version",
  ] as const) {
    if (reservation.plan[key] !== current[key])
      throw new Error(`Capture reservation changed ${key}.`);
  }
  if (reservation.plan.required_scopes.some((scope) => !current.required_scopes.includes(scope)))
    throw new Error("Capture reservation lost a required scope.");
  // Reservations sum to the original global allocation, even when its per-context
  // ceiling was higher than the number of tiles actually assigned to that context.
  const ceiling = reservation.selected_ids.length;
  const allocation = allocateTileBudget([current], ceiling, { [current.context_id]: ceiling })
    .contexts[0];
  if (
    allocation.coverage.capped ||
    allocation.coverage.omitted_scopes.length ||
    allocation.coverage.uncovered_intervals.length
  )
    throw new Error("Fresh native capture coverage exceeds the reserved tile budget.");
  return validatePageReviewAllocation(allocation, current);
}

export class CaptureSourceChanged extends Error {
  constructor(message = "Page source changed during the gate and capture transaction.") {
    super(message);
    this.name = "CaptureSourceChanged";
  }
}

/** Gate-hit annotations may change, but source and every native rectangle must stay fixed. */
export function assertGatePlanStable(
  before: PageReviewCapturePlan,
  after: PageReviewCapturePlan,
): void {
  if (capturePlanDigest(before) !== capturePlanDigest(after))
    throw new CaptureSourceChanged(
      "Page source or geometry changed while deterministic gates were running.",
    );
}

/** One retry recollects every gate and allocation; no previous green result survives. */
export async function runCaptureTransaction<T>(
  collectAndAllocate: (attempt: number) => Promise<void>,
  capture: () => Promise<T>,
  recordFailure: (attempt: number, error: unknown) => void,
): Promise<T> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await collectAndAllocate(attempt);
      return await capture();
    } catch (error) {
      recordFailure(attempt, error);
      if (!(error instanceof CaptureSourceChanged) || attempt === 2) throw error;
    }
  }
  throw new Error("Capture transaction did not complete.");
}
