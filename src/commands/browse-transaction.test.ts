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

test("a lazy image changing the document bottom retries full gates and native coverage", () => {
  const dir = mkdtempSync(join(tmpdir(), "browse-lazy-boundary-"));
  dirs.push(dir);
  const file = join(dir, "fixture.html");
  writeFileSync(
    file,
    `<!doctype html><style>html,body{margin:0}main{height:8303px}img{display:block;width:180px;height:auto}</style><main>Native boundary fixture</main><img loading="lazy" width="360" height="144" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='71'%3E%3Crect width='180' height='71' fill='red'/%3E%3C/svg%3E">`,
  );
  const run = (name: string, args: string[]) =>
    spawnSync(
      "bash",
      [
        resolve(import.meta.dir, "../../bin/harn"),
        "browse",
        pathToFileURL(file).href,
        "--json",
        "--no-cookies",
        "--viewport",
        "390x844",
        "--profile",
        join(dir, `${name}-profile`),
        "--out",
        join(dir, name),
        "--review-pack-context",
        "fixture",
        "--review-pack-plan",
        "--check-overflow",
        "--check-overflow-fail",
        ...args,
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
  const preliminary = run("plan", []);
  if (preliminary.status !== 0) throw Error(preliminary.stderr);
  const plan = JSON.parse(preliminary.stdout).review_pack_capture_plan;
  expect(plan.page_height).toBe(8375);
  const reservation = allocateTileBudget([plan], 24).contexts[0];
  const reservationFile = join(dir, "reservation.json");
  writeFileSync(reservationFile, JSON.stringify(reservation));
  const captured = run("capture", [
    "--review-pack",
    join(dir, "pack"),
    "--review-pack-reservation",
    reservationFile,
  ]);
  if (captured.status !== 0) throw Error(captured.stderr);
  const result = JSON.parse(captured.stdout);
  const attempts = result.review_pack_transaction.attempts;
  expect(attempts.filter((a: { status: string }) => a.status === "failed")).toHaveLength(1);
  expect(attempts.at(-1)).toMatchObject({ attempt: 2, status: "captured" });
  expect(result.review_pack_capture_plan.page_height).toBe(8374);
  expect(result.review_pack_transaction.source_digest).toBe(
    result.review_pack_capture_plan.source_digest,
  );
  const gates = JSON.parse(readFileSync(join(dir, "capture.attempt-2.gates.json"), "utf8"));
  expect(gates.attempt).toBe(2);
  expect(gates.overflow).toBeDefined();
  const record = JSON.parse(
    readFileSync(join(dir, "pack", "contexts", "fixture", "context.json"), "utf8"),
  );
  expect(record.capture_plan.page_height).toBe(8374);
  expect(record.capture_fidelity.probed.length).toBe(result.reviewPack.tiles);
  expect(record.capture_plan.source_digest).toBe(result.review_pack_transaction.source_digest);
  expect(result.reviewPack.tiles).toBeLessThanOrEqual(reservation.selected_ids.length);
}, 60000);
