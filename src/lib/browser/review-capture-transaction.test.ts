import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocateTileBudget } from "./page-review-budget.ts";
import {
  PAGE_REVIEW_CAPTURE_PLAN_SCHEMA,
  type PageReviewCapturePlan,
} from "./page-review-contracts.ts";
import { packPaths } from "./page-review-pack.ts";
import {
  allocateCaptureReservation,
  assertGatePlanStable,
  CaptureSourceChanged,
  runCaptureTransaction,
  writeCaptureTransaction,
} from "./review-capture-transaction.ts";

test("gate-window geometry drift refuses even with identical semantic source", () => {
  const before = plan();
  for (const mutate of [
    (p: PageReviewCapturePlan) => {
      p.page_height += 1;
    },
    (p: PageReviewCapturePlan) => {
      p.candidates[1].rect.y += 1;
    },
    (p: PageReviewCapturePlan) => {
      p.viewport_width += 1;
    },
  ]) {
    const after = structuredClone(before);
    mutate(after);
    expect(after.source_digest).toBe(before.source_digest);
    expect(() => assertGatePlanStable(before, after)).toThrow("geometry changed");
  }
  const annotated = structuredClone(before);
  annotated.candidates[0].gate_hits = [{ check_id: "visible", severity: "high" }];
  expect(() => assertGatePlanStable(before, annotated)).not.toThrow();
});

test("partial attempt files cannot enter the final context on retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capture-publication-"));
  let attempt = 0;
  try {
    await runCaptureTransaction(
      async () => {
        attempt++;
      },
      async () =>
        writeCaptureTransaction(dir, "fixture", (stage) => {
          const context = packPaths(stage).contextDir("fixture");
          mkdirSync(context, { recursive: true });
          writeFileSync(join(context, "context.json"), JSON.stringify({ attempt }));
          if (attempt === 1) {
            writeFileSync(join(context, "failed-sentinel"), "must not publish");
            throw new CaptureSourceChanged();
          }
          return { attempt };
        }),
      () => {
        expect(existsSync(packPaths(dir).contextDir("fixture"))).toBe(false);
      },
    );
    expect(
      JSON.parse(readFileSync(join(packPaths(dir).contextDir("fixture"), "context.json"), "utf8"))
        .attempt,
    ).toBe(2);
    expect(existsSync(join(packPaths(dir).contextDir("fixture"), "failed-sentinel"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function plan(count = 3): PageReviewCapturePlan {
  return {
    schema: PAGE_REVIEW_CAPTURE_PLAN_SCHEMA,
    context_id: "mobile",
    viewport: "320x240",
    viewport_width: 320,
    viewport_height: 240,
    theme: "light",
    state: "open",
    dpr: 1,
    page_width: 320,
    page_height: count * 200,
    source_digest: "a".repeat(64),
    recipe_version: "v2",
    required_scopes: [],
    candidates: Array.from({ length: count }, (_, i) => ({
      id: `b${i}`,
      index: i,
      label: `band${i}`,
      rect: { x: 0, y: i * 200, width: 320, height: 200 },
      gate_hits: [],
    })),
  };
}
test("fresh source is allocated within its reservation and keeps exact identity", () => {
  const initial = plan();
  const reserved = allocateTileBudget([initial], 10).contexts[0];
  const current = { ...initial, source_digest: "b".repeat(64) };
  const result = allocateCaptureReservation(reserved, current);
  expect(result.plan.source_digest).toBe(current.source_digest);
  expect(result.ceiling).toBe(reserved.selected_ids.length);
  expect(result.coverage.capped).toBe(false);
});
test("fresh page growth cannot borrow another context's tiles or omit native coverage", () => {
  const reserved = allocateTileBudget([plan()], 3).contexts[0];
  expect(() => allocateCaptureReservation(reserved, plan(4))).toThrow("reserved tile budget");
});
test("context, state and required scopes remain a floor", () => {
  const initial = plan();
  const reserved = allocateTileBudget([initial], 3).contexts[0];
  expect(() => allocateCaptureReservation(reserved, { ...initial, state: "closed" })).toThrow(
    "changed state",
  );
  reserved.plan.required_scopes = ["article"];
  // Recompute valid preliminary coverage so the test reaches the scope floor.
  const scoped = allocateTileBudget([reserved.plan], 3).contexts[0];
  expect(() => allocateCaptureReservation(scoped, initial)).toThrow();
});
test("one mutation recollects all gates and replaces the first result", async () => {
  const calls: string[] = [];
  let value = 0;
  const result = await runCaptureTransaction(
    async (attempt) => {
      calls.push(`gates${attempt}`);
      value = attempt;
    },
    async () => {
      calls.push(`capture${value}`);
      if (value === 1) throw new CaptureSourceChanged();
      return value;
    },
    (attempt) => calls.push(`failed${attempt}`),
  );
  expect(result).toBe(2);
  expect(calls).toEqual(["gates1", "capture1", "failed1", "gates2", "capture2"]);
});
test("continuous mutation fails after two attempts and retains both failures", async () => {
  const failures: number[] = [];
  let calls = 0;
  await expect(
    runCaptureTransaction(
      async () => {
        calls++;
      },
      async () => {
        throw new CaptureSourceChanged();
      },
      (n) => failures.push(n),
    ),
  ).rejects.toThrow("source changed");
  expect(calls).toBe(2);
  expect(failures).toEqual([1, 2]);
});
test("non-source gate/allocation failures never retry or capture", async () => {
  let captured = false;
  const failures: number[] = [];
  await expect(
    runCaptureTransaction(
      async () => {
        throw Error("native coverage missing");
      },
      async () => {
        captured = true;
      },
      (n) => failures.push(n),
    ),
  ).rejects.toThrow("native coverage missing");
  expect(captured).toBe(false);
  expect(failures).toEqual([1]);
});
