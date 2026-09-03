import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { allocateTileBudget } from "../lib/browser/page-review-budget.ts";
import type { PageReviewCapturePlan } from "../lib/browser/page-review-contracts.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("failed gate still emits a plan; capture uses exact IDs and refuses source drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "browse-allocation-"));
  dirs.push(dir);
  const file = join(dir, "fixture.html");
  writeFileSync(
    file,
    '<style>body{margin:0;height:4500px;background:linear-gradient(white,#abd)}article{height:600px;padding:20px}</style><article>Review fixture</article><script>let remaining=5;function initialize(){if(remaining--){requestAnimationFrame(initialize);return;}const el=document.querySelector("article");const attrs=["data-a","data-b"];for(const attr of attrs)el.setAttribute(attr,"ready");el.append(" initialized");}requestAnimationFrame(initialize);</script>',
  );
  const base = [
    pathToFileURL(file).href,
    "--json",
    "--no-cookies",
    "--viewport",
    "320x240",
    "--review-pack-context",
    "test",
    "--check-critique-band",
    "700",
  ];
  let n = 0;
  const run = (args: string[]) =>
    spawnSync(
      "bash",
      [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        ...base,
        "--profile",
        join(dir, `profile-${n++}`),
        "--evaluate",
        `(()=>{const el=document.querySelector("article");const attrs=${n % 2 ? '["data-a","data-b"]' : '["data-b","data-a"]'};for(const a of attrs)el.removeAttribute(a);for(const a of attrs)el.setAttribute(a,"ready");})()`,
        ...args,
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
  const gate = run(["--review-pack-plan", "--check-visible", "#missing", "--check-visible-fail"]);
  if (gate.status !== 2) throw new Error(gate.stderr);
  expect(gate.status).toBe(2);
  const plan = JSON.parse(gate.stdout).review_pack_capture_plan as PageReviewCapturePlan;
  expect(plan.candidates.length).toBeGreaterThan(4);
  const allocation = allocateTileBudget([plan], 3).contexts[0],
    path = join(dir, "allocation.json");
  writeFileSync(path, JSON.stringify(allocation));
  const captured = run(["--review-pack", join(dir, "pack"), "--review-pack-allocation", path]);
  if (captured.status !== 0) throw new Error(captured.stderr);
  expect(captured.status).toBe(0);
  const envelope = JSON.parse(captured.stdout);
  expect(envelope.reviewPack.tiles).toBe(3);
  const context = JSON.parse(
    readFileSync(join(dir, "pack", "contexts", "test", "context.json"), "utf8"),
  );
  expect(context.tiles.map((t: { scrollY: number }) => t.scrollY)).toEqual(
    allocation.selected_ids.map((id) => plan.candidates.find((c) => c.id === id)!.rect.y),
  );
  expect(context.allocation_coverage.uncovered_intervals.length).toBeGreaterThan(0);
  writeFileSync(file, readFileSync(file, "utf8").replace("Review fixture", "Changed fixture"));
  const stale = run(["--review-pack", join(dir, "changed-pack"), "--review-pack-allocation", path]);
  expect(stale.status).toBe(1);
  expect(stale.stderr).toContain("source changed");
}, 90000);
