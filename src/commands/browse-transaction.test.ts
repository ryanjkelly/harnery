import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { allocateTileBudget } from "../lib/browser/page-review-budget.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test("real capture repeats gates on its fresh page and rejects mutation and insufficient reservations", () => {
  const dir = mkdtempSync(join(tmpdir(), "browse-transaction-"));
  dirs.push(dir);
  const file = join(dir, "fixture.html");
  const html =
    "<style>body{margin:0;height:600px;background:linear-gradient(white,#abd)}article{padding:20px}</style><article>Actual capture fixture</article><script>document.body.dataset.instance=crypto.randomUUID();</script>";
  writeFileSync(file, html);
  let visit = 0;
  const run = (args: string[]) => {
    const prefix = join(dir, `visit-${visit++}`);
    const result = spawnSync(
      "bash",
      [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        pathToFileURL(file).href,
        "--json",
        "--no-cookies",
        "--viewport",
        "320x240",
        "--profile",
        `${prefix}-profile`,
        "--out",
        prefix,
        "--review-pack-context",
        "fixture",
        "--check-critique-band",
        "240",
        ...args,
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
    return { ...result, prefix };
  };
  const planned = run(["--review-pack-plan"]);
  if (planned.status !== 0) throw Error(planned.stderr);
  const plan = JSON.parse(planned.stdout).review_pack_capture_plan;
  const reservation = allocateTileBudget([plan], 24).contexts[0];
  const reservationFile = join(dir, "reservation.json");
  writeFileSync(reservationFile, JSON.stringify(reservation));
  const fresh = run([
    "--review-pack",
    join(dir, "fresh-pack"),
    "--review-pack-reservation",
    reservationFile,
    "--review-pack-plan",
    "--check-visible",
    "article",
    "--check-visible-fail",
  ]);
  if (fresh.status !== 0) throw Error(fresh.stderr);
  const envelope = JSON.parse(fresh.stdout);
  expect(envelope.review_pack_capture_plan.source_digest).not.toBe(plan.source_digest);
  expect(envelope.review_pack_transaction.source_digest).toBe(
    envelope.review_pack_capture_plan.source_digest,
  );
  expect(envelope.review_pack_transaction.attempts.at(-1).status).toBe("captured");
  expect(envelope.reviewPack.tiles).toBeLessThanOrEqual(reservation.selected_ids.length);
  const record = JSON.parse(
    readFileSync(join(dir, "fresh-pack", "contexts", "fixture", "context.json"), "utf8"),
  );
  expect(record.capture_plan.source_digest).toBe(envelope.review_pack_transaction.source_digest);
  const failed = run([
    "--review-pack",
    join(dir, "failed-gate-pack"),
    "--review-pack-reservation",
    reservationFile,
    "--review-pack-plan",
    "--check-visible",
    "#missing",
    "--check-visible-fail",
  ]);
  if (failed.status !== 2) throw Error(failed.stderr);
  expect(JSON.parse(failed.stdout).reviewPack.context_id).toBe("fixture");
  expect(JSON.parse(failed.stdout).review_pack_transaction.attempts.at(-1).status).toBe("captured");
  writeFileSync(file, html.replace("height:600px", "height:6000px"));
  const grown = run([
    "--review-pack",
    join(dir, "grown-pack"),
    "--review-pack-reservation",
    reservationFile,
    "--review-pack-plan",
  ]);
  expect(grown.status).toBe(1);
  expect(grown.stderr).toContain("reserved tile budget");
  expect(
    JSON.parse(readFileSync(`${grown.prefix}.capture-transaction.json`, "utf8")).attempts.at(-1)
      .status,
  ).toBe("failed");
  writeFileSync(
    file,
    html +
      '<script>let changes=0;addEventListener("scroll",()=>document.body.dataset.scrollChanges=String(++changes));</script>',
  );
  const mutated = run([
    "--review-pack",
    join(dir, "mutated-pack"),
    "--review-pack-reservation",
    reservationFile,
    "--review-pack-plan",
  ]);
  expect(mutated.status).toBe(1);
  const receipt = JSON.parse(readFileSync(`${mutated.prefix}.capture-transaction.json`, "utf8"));
  expect(receipt.attempts.filter((a: { status: string }) => a.status === "failed")).toHaveLength(2);
  expect(receipt.attempts.at(-1).attempt).toBe(2);
}, 120000);
