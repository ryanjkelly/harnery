import { createHash } from "node:crypto";
import {
  PAGE_REVIEW_CAPTURE_PLAN_SCHEMA,
  PAGE_REVIEW_DEFAULT_TILE_BUDGET,
  PAGE_REVIEW_MAX_TILE_BUDGET,
  type PageReviewBudgetCoverage,
  type PageReviewCandidate,
  type PageReviewCapturePlan,
  type PageReviewContextAllocation,
  type PageReviewRect,
  type PageReviewTileBudgetAllocation,
} from "./page-review-contracts.ts";

const severityRank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const position = (a: PageReviewCandidate, b: PageReviewCandidate) =>
  a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.index - b.index || a.id.localeCompare(b.id);

export function validatePageReviewCapturePlan(value: unknown): PageReviewCapturePlan {
  const fail = (detail: string): never => {
    throw new Error(`Invalid page review capture plan: ${detail}; rerun planning.`);
  };
  if (!value || typeof value !== "object") fail("expected an object");
  const p = value as PageReviewCapturePlan;
  if (p.schema !== PAGE_REVIEW_CAPTURE_PLAN_SCHEMA) fail("unsupported schema");
  for (const key of [
    "context_id",
    "viewport",
    "state",
    "source_digest",
    "recipe_version",
  ] as const) {
    if (typeof p[key] !== "string" || !p[key].trim()) fail(`missing ${key}`);
  }
  if (p.theme !== "light" && p.theme !== "dark") fail("invalid theme");
  if (!Number.isFinite(p.dpr) || p.dpr <= 0) fail("invalid DPR");
  for (const key of ["viewport_width", "viewport_height", "page_width", "page_height"] as const) {
    if (!Number.isSafeInteger(p[key]) || p[key] <= 0) fail(`invalid ${key}`);
  }
  if (!Array.isArray(p.candidates) || !p.candidates.length) fail("no candidates");
  const seen = new Set<string>();
  for (const c of p.candidates) {
    if (!c || typeof c.id !== "string" || !c.id || seen.has(c.id))
      fail("missing or duplicate candidate ID");
    seen.add(c.id);
    if (!Number.isSafeInteger(c.index) || c.index < 0 || typeof c.label !== "string")
      fail(`invalid candidate ${c.id}`);
    const r = c.rect;
    if (
      !r ||
      ![r.x, r.y, r.width, r.height].every(Number.isSafeInteger) ||
      r.x < 0 ||
      r.y < 0 ||
      r.width <= 0 ||
      r.height <= 0 ||
      r.x + r.width > p.page_width ||
      r.y + r.height > p.page_height
    )
      fail(`invalid rectangle ${c.id}`);
    if (c.scope !== undefined && (typeof c.scope !== "string" || !c.scope))
      fail(`invalid scope ${c.id}`);
    if (
      !Array.isArray(c.gate_hits) ||
      c.gate_hits.some(
        (h) => !h || typeof h.check_id !== "string" || !h.check_id || !(h.severity in severityRank),
      )
    )
      fail(`invalid gate hits ${c.id}`);
  }
  if (
    p.required_scopes !== undefined &&
    (!Array.isArray(p.required_scopes) ||
      p.required_scopes.some((s) => typeof s !== "string" || !s))
  )
    fail("invalid required scopes");
  const bands = p.candidates.filter((c) => c.scope === undefined).sort(position);
  if (
    !bands.length ||
    bands[0].rect.y !== 0 ||
    bands.at(-1)!.rect.y + bands.at(-1)!.rect.height !== p.page_height
  )
    fail("top and bottom page bands are required");
  return p;
}

export function intervalUnion(
  rects: readonly PageReviewRect[],
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const r of [...rects].sort((a, b) => a.y - b.y || a.height - b.height)) {
    const last = out.at(-1);
    if (last && r.y <= last.end) last.end = Math.max(last.end, r.y + r.height);
    else out.push({ start: r.y, end: r.y + r.height });
  }
  return out;
}

export function allocationCoverage(
  plan: PageReviewCapturePlan,
  selectedIds: readonly string[],
): PageReviewBudgetCoverage {
  const selected = new Set(selectedIds);
  const kept = plan.candidates.filter((c) => selected.has(c.id));
  // A narrow scope cannot stand in for a full-width document band.
  const reviewed = intervalUnion(
    kept
      .filter((c) => !c.scope && c.rect.x === 0 && c.rect.width === plan.page_width)
      .map((c) => c.rect),
  );
  const uncovered: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const r of reviewed) {
    if (r.start > cursor) uncovered.push({ start: cursor, end: r.start });
    cursor = r.end;
  }
  if (cursor < plan.page_height) uncovered.push({ start: cursor, end: plan.page_height });
  const missed = plan.candidates.filter((c) => !selected.has(c.id));
  const scopes = new Set([
    ...(plan.required_scopes ?? []),
    ...plan.candidates.flatMap((c) => (c.scope ? [c.scope] : [])),
  ]);
  const omittedScopes = [...scopes]
    .filter((s) => !plan.candidates.some((c) => c.scope === s) || missed.some((c) => c.scope === s))
    .sort();
  return {
    page_height_px: plan.page_height,
    reviewed_height_px: reviewed.reduce((sum, r) => sum + r.end - r.start, 0),
    bands_total: plan.candidates.filter((c) => !c.scope).length,
    bands_reviewed: kept.filter((c) => !c.scope).length,
    capped: uncovered.length > 0 || omittedScopes.length > 0 || missed.some((c) => !c.scope),
    selected_rectangles: kept.map((c) => ({ ...c.rect })),
    reviewed_intervals: reviewed,
    uncovered_intervals: uncovered,
    omitted_gate_hits: [
      ...new Set(missed.flatMap((c) => c.gate_hits.map((h) => h.check_id))),
    ].sort(),
    omitted_scopes: omittedScopes,
  };
}

/** Reserve edges, prioritize gate hits, then distribute by remaining height. */
export function allocateTileBudget(
  plans: PageReviewCapturePlan[],
  budget = PAGE_REVIEW_DEFAULT_TILE_BUDGET,
  ceilings?: Record<string, number>,
): PageReviewTileBudgetAllocation {
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > PAGE_REVIEW_MAX_TILE_BUDGET)
    throw new Error(`Tile budget must be an integer from 1 to ${PAGE_REVIEW_MAX_TILE_BUDGET}.`);
  const rows = [...plans]
    .map(validatePageReviewCapturePlan)
    .sort((a, b) => a.context_id.localeCompare(b.context_id))
    .map((plan) => {
      const bands = plan.candidates.filter((c) => !c.scope).sort(position);
      const edges = [bands[0], bands.at(-1)!].filter(
        (c, i, a) => a.findIndex((x) => x.id === c.id) === i,
      );
      const ceiling = ceilings?.[plan.context_id] ?? budget;
      if (!Number.isSafeInteger(ceiling) || ceiling < edges.length)
        throw new Error(
          `Context ${plan.context_id} requires a tile ceiling of at least ${edges.length} for its top and bottom bands (got ${ceiling}).`,
        );
      return { plan, ceiling, selected: new Set(edges.map((c) => c.id)) };
    });
  if (new Set(rows.map((r) => r.plan.context_id)).size !== rows.length)
    throw new Error("Duplicate page review context ID.");
  let used = rows.reduce((s, r) => s + r.selected.size, 0);
  if (used > budget)
    throw new Error(
      `Tile budget requires at least ${used} to reserve every context's top and bottom bands (got ${budget}).`,
    );
  const hits = rows.flatMap((row) =>
    row.plan.candidates
      .filter((c) => c.gate_hits.length && !row.selected.has(c.id))
      .map((c) => ({
        row,
        c,
        rank: Math.min(...c.gate_hits.map((h) => severityRank[h.severity])),
      })),
  );
  hits.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.row.plan.context_id.localeCompare(b.row.plan.context_id) ||
      position(a.c, b.c),
  );
  for (const { row, c } of hits) {
    if (used >= budget) break;
    if (row.selected.size >= row.ceiling) continue;
    row.selected.add(c.id);
    used++;
  }
  const remaining = (row: (typeof rows)[number]) =>
    row.plan.candidates.filter((c) => !row.selected.has(c.id)).sort(position);
  while (used < budget) {
    const eligible = rows
      .map((row) => {
        const candidates = remaining(row);
        return {
          row,
          candidates,
          capacity: Math.min(candidates.length, row.ceiling - row.selected.size),
          height: intervalUnion(candidates.map((c) => c.rect)).reduce(
            (s, r) => s + r.end - r.start,
            0,
          ),
          quota: 0,
          fraction: 0,
        };
      })
      .filter((r) => r.capacity > 0);
    if (!eligible.length) break;
    const slots = budget - used,
      totalHeight = eligible.reduce((s, r) => s + r.height, 0);
    for (const r of eligible) {
      const exact = (slots * r.height) / totalHeight;
      r.quota = Math.min(r.capacity, Math.floor(exact));
      r.fraction = exact - Math.floor(exact);
    }
    let spare = slots - eligible.reduce((s, r) => s + r.quota, 0);
    for (const r of [...eligible].sort(
      (a, b) =>
        b.fraction - a.fraction || a.row.plan.context_id.localeCompare(b.row.plan.context_id),
    )) {
      if (spare > 0 && r.quota < r.capacity) {
        r.quota++;
        spare--;
      }
    }
    for (const r of eligible) {
      for (let i = 0; i < r.quota; i++) {
        const index = Math.floor(((i + 0.5) * r.candidates.length) / r.quota);
        r.row.selected.add(r.candidates[index].id);
        used++;
      }
    }
  }
  return {
    budget,
    used,
    contexts: rows.map(({ plan, ceiling, selected }) => {
      const selected_ids = plan.candidates
        .filter((c) => selected.has(c.id))
        .sort(position)
        .map((c) => c.id);
      return {
        context_id: plan.context_id,
        plan,
        selected_ids,
        ceiling,
        omitted_candidates: plan.candidates
          .filter((c) => !selected.has(c.id))
          .map((c) => ({
            id: c.id,
            reason:
              ceilings?.[plan.context_id] !== undefined && selected.size >= ceiling
                ? ("ceiling" as const)
                : ("budget" as const),
          })),
        coverage: allocationCoverage(plan, selected_ids),
      };
    }),
  };
}

/** Gate-hit annotations are planning results; geometry and page state are authoritative at capture. */
export function capturePlanDigest(plan: PageReviewCapturePlan): string {
  const { candidates, ...rest } = plan;
  return createHash("sha256")
    .update(JSON.stringify({ ...rest, candidates: candidates.map(({ gate_hits, ...c }) => c) }))
    .digest("hex");
}

export function validatePageReviewAllocation(
  value: unknown,
  current: PageReviewCapturePlan,
): PageReviewContextAllocation {
  const allocation = value as PageReviewContextAllocation;
  if (!allocation || typeof allocation !== "object")
    throw new Error("Missing page review allocation; rerun planning.");
  validatePageReviewCapturePlan(allocation.plan);
  if (
    allocation.context_id !== current.context_id ||
    capturePlanDigest(allocation.plan) !== capturePlanDigest(current)
  )
    throw new Error(
      "Page review capture geometry or source changed since planning; rerun the review.",
    );
  if (
    !Array.isArray(allocation.selected_ids) ||
    !allocation.selected_ids.length ||
    new Set(allocation.selected_ids).size !== allocation.selected_ids.length ||
    allocation.selected_ids.some((id) => !current.candidates.some((c) => c.id === id))
  )
    throw new Error("Invalid selected tile IDs in page review allocation.");
  if (
    !Number.isSafeInteger(allocation.ceiling) ||
    allocation.selected_ids.length > allocation.ceiling
  )
    throw new Error("Page review allocation exceeds its context ceiling.");
  const bands = current.candidates.filter((c) => !c.scope).sort(position);
  if (
    !allocation.selected_ids.includes(bands[0].id) ||
    !allocation.selected_ids.includes(bands.at(-1)!.id)
  )
    throw new Error("Page review allocation must include top and bottom bands.");
  const coverage = allocationCoverage(allocation.plan, allocation.selected_ids);
  if (JSON.stringify(coverage) !== JSON.stringify(allocation.coverage))
    throw new Error("Page review allocation coverage is inconsistent with selected tiles.");
  return { ...allocation, coverage };
}
