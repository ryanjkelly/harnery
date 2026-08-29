import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countRecentCodexMidFlightOnboardings } from "../../../../commands/doctor.ts";
import { acquireNoClobberLease } from "../../../workflow/workspaces/leases.ts";
import {
  countSummarizedSinceV3,
  DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT,
  DIAGNOSTIC_SUMMARY_FORMAT,
  DIAGNOSTIC_SUMMARY_VERSION,
  type DiagnosticSummaryV3,
  diagnosticSummariesRootV3,
  gateProducerDiagnosticV3,
  listDiagnosticSummariesV3,
} from "./diagnostic-summaries.ts";
import { writeProducerDiagnosticV3 } from "./intake.ts";

const roots: string[] = [];
const KILL_SWITCH = "HARNERY_V3_DIAGNOSTIC_SUMMARIES";
/** The loose-filename shape `agents health` parses; new names must keep it. */
const HEALTH_LOOSE_NAME = /^(.+)-(\d{15})-\d{20}-\d+-[0-9a-f-]+\.json$/;

afterEach(() => {
  delete process.env[KILL_SWITCH];
  for (const root of roots.splice(0)) {
    // Restore permissions a fail-open test may have narrowed.
    try {
      chmodSync(join(root, ".harnery", "ledgers", "v3"), 0o700);
    } catch {
      // Directory may not exist for every test.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harn-diag-summaries-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"), { recursive: true });
  return root;
}

function looseDir(root: string): string {
  return join(root, ".harnery", "ledgers", "v3", "diagnostics");
}

function looseFiles(root: string, prefix: string): string[] {
  const directory = looseDir(root);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.startsWith(`${prefix}-`));
}

function digestOf(category: string, reason: string, instanceId: string): string {
  return createHash("sha256")
    .update(`${category}\n${reason}\n${instanceId}`)
    .digest("hex")
    .slice(0, 16);
}

/** Write a loose diagnostic file whose name places it at epochMs for a key. */
function fabricateLooseFile(root: string, category: string, epochMs: number, digest: string): void {
  const directory = looseDir(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const orderKey = [
    String(epochMs).padStart(15, "0"),
    "1".repeat(20),
    String(process.pid),
    randomUUID(),
  ].join("-");
  writeFileSync(
    join(directory, `${category}-${orderKey}-${digest}.json`),
    `${JSON.stringify({ recorded_at: new Date(epochMs).toISOString(), category })}\n`,
    { mode: 0o600 },
  );
}

function gateInput(overrides: Partial<Parameters<typeof gateProducerDiagnosticV3>[1]> = {}) {
  return {
    category: "flood_case",
    reason: "turn_not_started",
    instanceId: "inst_fixture",
    fingerprint: { bytes: 120, sha256: "a".repeat(64) },
    metadata: { adapter: "claude-code", platform: "linux" as const },
    ...overrides,
  };
}

describe("diagnostic summary gate", () => {
  test("creates zero mitigation state below the per-key limit", () => {
    const root = temporaryRoot();
    const digest = digestOf("under_limit", "r1", "inst_a");
    for (let index = 0; index < 5; index += 1) {
      expect(
        writeProducerDiagnosticV3(root, "under_limit", {
          reason: "r1",
          instance_id: "inst_a",
        }),
      ).toBeDefined();
    }
    const names = looseFiles(root, "under_limit");
    expect(names).toHaveLength(5);
    for (const name of names) {
      // Admitted names carry the key digest and still parse as loose files.
      expect(name.endsWith(`-${digest}.json`)).toBe(true);
      expect(HEALTH_LOOSE_NAME.test(name)).toBe(true);
    }
    // No summary file, no lease directory, no summaries subtree at all.
    expect(existsSync(diagnosticSummariesRootV3(root))).toBe(false);
  });

  test("coalesces past the limit with exact reconciliation of every emission", () => {
    const root = temporaryRoot();
    const emissions = DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 8;
    let lastPath: string | undefined;
    for (let index = 0; index < emissions; index += 1) {
      lastPath = writeProducerDiagnosticV3(root, "flood_case", {
        reason: "turn_not_started",
        instance_id: "inst_flood",
        adapter: "claude-code",
      });
    }
    const loose = looseFiles(root, "flood_case");
    expect(loose).toHaveLength(DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT);
    // A coalesced emission still returns its durable record: the summary.
    expect(lastPath).toBeDefined();
    expect(lastPath).toContain("diagnostic-summaries");
    const listing = listDiagnosticSummariesV3(root);
    expect(listing.summaries).toHaveLength(1);
    const summary = listing.summaries[0];
    if (!summary) throw new Error("expected a summary");
    expect(summary.loose_count).toBe(DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT);
    expect(summary.summarized_count).toBe(8);
    // Exact reconciliation: physical loose files + summarized == emissions.
    expect(loose.length + summary.summarized_count).toBe(emissions);
    expect(summary.first_summarized_at).not.toBeNull();
    expect(summary.last_summarized_at).not.toBeNull();
    expect(summary.exemplars.length).toBeGreaterThan(0);
    expect(summary.exemplars.length).toBeLessThanOrEqual(4);
    expect(summary.metadata.adapter).toBe("claude-code");
    const bucketSum = Object.values(summary.recent_hours).reduce((sum, value) => sum + value, 0);
    expect(bucketSum).toBe(8);
    expect(summary.represented_bytes).toBeGreaterThan(0);
  });

  test("bounds each (category, reason, instance) key independently", () => {
    const root = temporaryRoot();
    for (let index = 0; index < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 2; index += 1) {
      writeProducerDiagnosticV3(root, "keyed_case", { reason: "ra", instance_id: "inst_1" });
    }
    for (let index = 0; index < 3; index += 1) {
      writeProducerDiagnosticV3(root, "keyed_case", { reason: "rb", instance_id: "inst_1" });
      writeProducerDiagnosticV3(root, "keyed_case", { reason: "ra", instance_id: "inst_2" });
    }
    // Only the flooded key crossed; the sibling keys stayed stateless.
    const listing = listDiagnosticSummariesV3(root);
    expect(listing.summaries).toHaveLength(1);
    expect(listing.summaries[0]?.summarized_count).toBe(2);
    expect(looseFiles(root, "keyed_case")).toHaveLength(DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 6);
  });

  test("opens a fresh window and admits loose exemplars again on a new UTC day", () => {
    const root = temporaryRoot();
    const day1 = Date.parse("2026-08-28T10:00:00.000Z");
    const day2 = Date.parse("2026-08-29T10:00:00.000Z");
    const input = gateInput();
    const digest = digestOf("flood_case", "turn_not_started", "inst_fixture");
    for (let index = 0; index < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT; index += 1) {
      fabricateLooseFile(root, "flood_case", day1 + index, digest);
    }
    expect(gateProducerDiagnosticV3(root, input, day1).admit).toBe(false);
    expect(gateProducerDiagnosticV3(root, input, day2).admit).toBe(true);
    const listing = listDiagnosticSummariesV3(root);
    expect(listing.summaries.map((summary) => summary.window)).toEqual(["2026-08-28"]);
    expect(listing.summaries[0]?.loose_count).toBe(DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT);
  });

  test("kill switch disables the gate entirely and writes nothing new", () => {
    const root = temporaryRoot();
    process.env[KILL_SWITCH] = "0";
    for (let index = 0; index < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 10; index += 1) {
      expect(
        writeProducerDiagnosticV3(root, "kill_switch", { reason: "r", instance_id: "inst_k" }),
      ).toBeDefined();
    }
    expect(looseFiles(root, "kill_switch")).toHaveLength(DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 10);
    expect(existsSync(diagnosticSummariesRootV3(root))).toBe(false);
  });

  test("fails open to the loose diagnostic when summary storage is unavailable", () => {
    const root = temporaryRoot();
    const digest = digestOf("fail_open", "r", "inst_f");
    for (let index = 0; index < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT; index += 1) {
      fabricateLooseFile(root, "fail_open", Date.now() - index, digest);
    }
    const v3Dir = join(root, ".harnery", "ledgers", "v3");
    rmSync(diagnosticSummariesRootV3(root), { recursive: true, force: true });
    // Freeze the v3 directory so the summaries subtree cannot be created;
    // the loose spool directory itself stays writable.
    chmodSync(v3Dir, 0o500);
    try {
      const path = writeProducerDiagnosticV3(root, "fail_open", {
        reason: "r",
        instance_id: "inst_f",
      });
      // Past the bound but the mitigation is broken: the emission lands loose.
      expect(path).toBeDefined();
      expect(path).toContain("diagnostics");
      expect(looseFiles(root, "fail_open")).toHaveLength(DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 1);
    } finally {
      chmodSync(v3Dir, 0o700);
    }
  });

  test("fails open under live lease contention and logs the emergency", () => {
    const root = temporaryRoot();
    const digest = digestOf("flood_case", "turn_not_started", "inst_fixture");
    for (let index = 0; index < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT; index += 1) {
      fabricateLooseFile(root, "flood_case", Date.now() - index, digest);
    }
    const summariesRoot = diagnosticSummariesRootV3(root);
    const lease = acquireNoClobberLease({
      path: join(summariesRoot, "leases", digest),
      scope: "event-v3-diagnostic-summary",
      authoritySha256: createHash("sha256").update(resolve(summariesRoot)).digest("hex"),
      staleAfterMs: 60_000,
    });
    try {
      const decision = gateProducerDiagnosticV3(root, gateInput());
      expect(decision.admit).toBe(true);
      if (decision.admit) expect(decision.loose_name_suffix).toBe(`-${digest}`);
    } finally {
      lease.release();
    }
    const listing = listDiagnosticSummariesV3(root);
    expect(listing.mitigation_health?.fail_open_count ?? 0).toBeGreaterThanOrEqual(1);
    expect(listing.mitigation_health?.by_stage.coalesce ?? 0).toBeGreaterThanOrEqual(1);
    // The contended emission stayed loose-eligible; no summary was created.
    expect(listing.summaries).toHaveLength(0);
  });

  test("releases the per-key lease directory once coalescing finishes", () => {
    const root = temporaryRoot();
    for (let index = 0; index < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 1; index += 1) {
      writeProducerDiagnosticV3(root, "lease_case", { reason: "r", instance_id: "inst_l" });
    }
    const leasesDir = join(diagnosticSummariesRootV3(root), "leases");
    expect(existsSync(leasesDir) ? readdirSync(leasesDir) : []).toHaveLength(0);
  });

  test("listing skips lease state and temp residue from a crashed publisher", () => {
    const root = temporaryRoot();
    for (let index = 0; index < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 1; index += 1) {
      writeProducerDiagnosticV3(root, "residue_case", { reason: "r", instance_id: "inst_r" });
    }
    const summariesRoot = diagnosticSummariesRootV3(root);
    mkdirSync(join(summariesRoot, "leases"), { recursive: true, mode: 0o700 });
    writeFileSync(join(summariesRoot, "orphan.json.tmp-999-dead"), "{", { mode: 0o600 });
    writeFileSync(join(summariesRoot, "garbage.json"), "not json", { mode: 0o600 });
    const listing = listDiagnosticSummariesV3(root);
    expect(listing.summaries).toHaveLength(1);
    expect(listing.unreadable_count).toBe(1);
    // The gate still coalesces beside the residue.
    const path = writeProducerDiagnosticV3(root, "residue_case", {
      reason: "r",
      instance_id: "inst_r",
    });
    expect(path).toContain("diagnostic-summaries");
  });

  test("drops malformed rate buckets instead of counting them inconsistently", () => {
    const root = temporaryRoot();
    const summariesRoot = diagnosticSummariesRootV3(root);
    mkdirSync(summariesRoot, { recursive: true, mode: 0o700 });
    const summary = {
      format: DIAGNOSTIC_SUMMARY_FORMAT,
      format_version: DIAGNOSTIC_SUMMARY_VERSION,
      category: "bucket_case",
      reason: "r",
      instance_id: "inst_b",
      window: "2026-08-29",
      loose_count: 32,
      summarized_count: 9,
      first_summarized_at: "2026-08-29T10:00:00.000Z",
      last_summarized_at: "2026-08-29T11:00:00.000Z",
      represented_bytes: 100,
      exemplars: [],
      metadata: {},
      recent_hours: { "2026-08-29T10": 4, "2026-08-29T11": "5", "not-an-hour": 3 },
    };
    writeFileSync(
      join(summariesRoot, "bucket_case-20260829-0000000000000000.json"),
      `${JSON.stringify(summary)}\n`,
      { mode: 0o600 },
    );
    const listing = listDiagnosticSummariesV3(root);
    expect(listing.summaries).toHaveLength(1);
    expect(listing.summaries[0]?.recent_hours).toEqual({ "2026-08-29T10": 4 });
  });

  test("window counting is hour-granular, boundary-exclusive, and skew-proof", () => {
    const summary: DiagnosticSummaryV3 = {
      format: DIAGNOSTIC_SUMMARY_FORMAT,
      format_version: DIAGNOSTIC_SUMMARY_VERSION,
      category: "window_case",
      reason: "r",
      instance_id: "inst_w",
      window: "2026-08-29",
      loose_count: 32,
      summarized_count: 15,
      first_summarized_at: "2026-08-29T09:10:00.000Z",
      last_summarized_at: "2026-08-29T11:00:00.000Z",
      represented_bytes: 100,
      exemplars: [],
      metadata: {},
      recent_hours: { "2026-08-29T09": 5, "2026-08-29T10": 7, "2026-08-29T11": 3 },
    };
    const nowMs = Date.parse("2026-08-29T10:30:00.000Z");
    const sinceMs = nowMs - 60 * 60 * 1000; // 09:30Z
    // The 09 bucket straddles the boundary (excluded); the 11 bucket is
    // future-dated relative to now (excluded); only the 10 bucket counts.
    expect(countSummarizedSinceV3([summary], sinceMs, undefined, nowMs)).toBe(7);
    // A wider window that fully contains all recorded, non-future hours.
    expect(countSummarizedSinceV3([summary], nowMs - 3 * 60 * 60 * 1000, undefined, nowMs)).toBe(
      12,
    );
  });

  test("doctor counts summarized codex mid-flight onboardings inside its window", () => {
    const root = temporaryRoot();
    const emissions = DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 3;
    for (let index = 0; index < emissions; index += 1) {
      writeProducerDiagnosticV3(root, "mid_flight_onboarding", {
        adapter: "codex",
        reason: "thread_id_missing",
        instance_id: "inst_codex",
      });
    }
    expect(looseFiles(root, "mid_flight_onboarding")).toHaveLength(DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT);
    expect(countRecentCodexMidFlightOnboardings(root)).toBe(emissions);
  });

  test("concurrent multi-process writers reconcile to the exact logical count", async () => {
    const root = temporaryRoot();
    const intakePath = join(import.meta.dir, "intake.ts");
    const perProcess = 20;
    const processes = 4;
    const script = [
      `const { writeProducerDiagnosticV3 } = await import(${JSON.stringify(intakePath)});`,
      `for (let index = 0; index < ${perProcess}; index += 1) {`,
      `  writeProducerDiagnosticV3(${JSON.stringify(root)}, "concurrent_case", {`,
      `    reason: "shared", instance_id: "inst_shared", adapter: "claude-code",`,
      `  });`,
      `}`,
    ].join("\n");
    const children = Array.from({ length: processes }, () =>
      Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" }),
    );
    const exits = await Promise.all(children.map((child) => child.exited));
    expect(exits).toEqual([0, 0, 0, 0]);

    const loose = looseFiles(root, "concurrent_case");
    const listing = listDiagnosticSummariesV3(root);
    const summarized = listing.summaries.reduce(
      (sum, summary) => sum + summary.summarized_count,
      0,
    );
    const failOpen = listing.mitigation_health?.fail_open_count ?? 0;
    // Every emission is accounted for exactly once: as a loose file or as a
    // summarized occurrence (a fail-open lands loose and is logged besides).
    expect(loose.length + summarized).toBe(processes * perProcess);
    // The lock-free filename count can admit up to one extra exemplar per
    // concurrent peer at the crossing; fail-opens admit loose files too.
    expect(loose.length).toBeLessThanOrEqual(
      DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + (processes - 1) + failOpen,
    );
  });

  test("summary contents never include raw payload fields", () => {
    const root = temporaryRoot();
    for (let index = 0; index < DIAGNOSTIC_LOOSE_EXEMPLAR_LIMIT + 2; index += 1) {
      writeProducerDiagnosticV3(root, "privacy_case", {
        reason: "r",
        instance_id: "inst_p",
        prompt: "SECRET-PROMPT-BODY",
        command: "SECRET-COMMAND",
      });
    }
    const summariesRoot = diagnosticSummariesRootV3(root);
    for (const name of readdirSync(summariesRoot)) {
      if (name === "leases") continue;
      const contents = readFileSync(join(summariesRoot, name), "utf8");
      expect(contents).not.toContain("SECRET-PROMPT-BODY");
      expect(contents).not.toContain("SECRET-COMMAND");
    }
  });
});
