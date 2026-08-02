import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import { fileDecision, resolveDecision } from "../lib/decision/index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-decision-cli-"));
  roots.push(root);
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  return root;
}

/** Run one CLI invocation and capture what it emitted.
 *
 * A refusal emits its error and then exits, so the emitted value is the thing
 * worth asserting on; whatever the process teardown throws afterwards is noise.
 * Swallowing the throw here keeps that distinction in one place. */
async function run(argv: string[]): Promise<{ data: unknown; error: unknown; threw: unknown }> {
  let data: unknown;
  let error: unknown;
  let threw: unknown;
  const emit: EmitContext = {
    data: (value: unknown) => {
      data = value;
    },
    error: (value: unknown) => {
      error = value;
    },
  } as unknown as EmitContext;
  const program = createHarneryProgram({ emit });
  try {
    await program.parseAsync(["node", "harn", ...argv]);
  } catch (e) {
    threw = e;
  }
  return { data, error, threw };
}

type Row = { decision_id: string; stakes: string; tier: number; filed_at: string };

describe("decision list --waiting", () => {
  test("returns only what a human still owes a ruling on", async () => {
    const root = fixture();
    // Tier 2 is the only tier that parks work; tier 0/1 already proceeded on a
    // default, which is exactly why they must not dilute this list.
    fileDecision(root, { question: "Ship the rewrite?", tier: 2, stakes: "high" });
    fileDecision(root, { question: "Name the flag?", tier: 1, stakes: "small" });
    fileDecision(root, { question: "Pick an idiom?", tier: 0, stakes: "small" });

    const { data } = await run(["decision", "list", "--waiting"]);
    const rows = (data as { rows: Row[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tier).toBe(2);
    expect((data as { meta: { filter: { waiting: boolean } } }).meta.filter.waiting).toBe(true);
  });

  test("a resolved tier 2 is no longer waiting on anyone", async () => {
    const root = fixture();
    const filed = fileDecision(root, {
      question: "Ship the rewrite?",
      tier: 2,
      stakes: "high",
    });
    const id = filed.manifest?.decision_id;
    if (!id) throw new Error("fixture decision was not filed");

    expect(
      ((await run(["decision", "list", "--waiting"])).data as { rows: Row[] }).rows,
    ).toHaveLength(1);

    // Assert the resolve landed. Without this the test can pass for the wrong
    // reason: a rejected resolution leaves the decision open, and "still open"
    // is indistinguishable from "the filter is broken".
    const resolved = resolveDecision(root, id, {
      recommendation: "Ship it",
      evidence: ["measured the rollback cost at under five minutes"],
      resolved_by: "operator",
    });
    expect(resolved.ok).toBe(true);

    const after = ((await run(["decision", "list", "--waiting"])).data as { rows: Row[] }).rows;
    expect(after).toHaveLength(0);
  });

  test("orders by stakes, then by how long it has gone unanswered", async () => {
    const root = fixture();
    // Filed newest-first on purpose: the default listing order is filed-desc, so
    // if the sort were not applied the old high-stakes entry would come last.
    const mk = (question: string, stakes: "high" | "medium", filedAt: string) => {
      const r = fileDecision(root, { question, tier: 2, stakes });
      const id = r.manifest?.decision_id;
      if (!id) throw new Error("fixture decision was not filed");
      // Backdate through the manifest so age is deterministic in the test.
      const path = join(root, ".harnery", "decisions", `${id}.json`);
      const m = JSON.parse(readFileSync(path, "utf8"));
      m.filed_at = filedAt;
      writeFileSync(path, JSON.stringify(m));
      return id;
    };
    const freshHigh = mk("Fresh but high", "high", "2026-08-01T00:00:00.000Z");
    const oldHigh = mk("Old and high", "high", "2026-07-01T00:00:00.000Z");
    const oldMedium = mk("Oldest of all, but medium", "medium", "2026-06-01T00:00:00.000Z");

    const rows = ((await run(["decision", "list", "--waiting"])).data as { rows: Row[] }).rows;
    // Stakes leads, so the medium sinks even though it is the oldest; within
    // equal stakes the one that has waited longest comes first.
    expect(rows.map((r) => r.decision_id)).toEqual([oldHigh, freshHigh, oldMedium]);
  });

  test("refuses a tier filter that contradicts --waiting instead of quietly winning", async () => {
    fixture();
    // This command's refusal path ends in process.exit, which would take the
    // test runner with it, so trade the exit for a throw just here and put it
    // back afterwards. Stubbing beats loosening the command: an operator who
    // typed a contradiction should be told, not silently overruled.
    const realExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;
    let error: unknown;
    let threw: unknown;
    try {
      ({ error, threw } = await run(["decision", "list", "--waiting", "--tier", "1"]));
    } finally {
      process.exit = realExit;
    }
    expect((error as { message?: string } | undefined)?.message).toMatch(/tier 2 by definition/);
    // And it really did stop rather than falling through to a listing.
    expect((threw as Error | undefined)?.message).toBe("exit:1");
  });
});
