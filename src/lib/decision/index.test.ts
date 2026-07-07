import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archiveDecision,
  archivedManifestPath,
  buildDecisionId,
  canTransition,
  claimDecision,
  DECISION_SCHEMA_VERSION,
  type DecisionManifest,
  decisionBodyDir,
  deriveSlug,
  enactDecision,
  escalateToCouncil,
  fileDecision,
  isStakes,
  isStatus,
  isTerminal,
  isTier,
  isVerdict,
  LEGAL_TRANSITIONS,
  listDecisions,
  manifestPath,
  readManifest,
  resolveDecision,
  reviewDecision,
  searchDecisions,
  showDecision,
  supersedeDecision,
  triageDecision,
  wontfixDecision,
  writeManifest,
} from "./index.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-decision-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** File a decision and return its id (helper for transition tests). */
function file(overrides: Partial<Parameters<typeof fileDecision>[1]> = {}): string {
  const r = fileDecision(root, {
    question: "Should fct_foo be incremental or a full rebuild?",
    tier: 1,
    stakes: "medium",
    ...overrides,
  });
  expect(r.ok).toBe(true);
  return r.manifest!.decision_id;
}

const goodResolution = {
  recommendation: "Make it incremental, partitioned by day.",
  evidence: ["bp bq inventory shows 4y of data", "full rebuild timed out at PER_PAGE=5000"],
  resolved_by: "agent-Sweeper",
};

// ─── slug / id ────────────────────────────────────────────────────────────────

describe("deriveSlug / buildDecisionId", () => {
  test("slug keeps first 5 words, kebab, alnum-only", () => {
    expect(deriveSlug("Should fct_foo be incremental or full??")).toBe(
      "should-fct-foo-be-incremental",
    );
  });

  test("empty question falls back to 'decision'", () => {
    expect(deriveSlug("!!! ??? ")).toBe("decision");
  });

  test("id shape is <slug>-<date>-<4hex>", () => {
    const id = buildDecisionId("Pick the retry backoff", new Date("2026-07-06T12:00:00Z"));
    expect(id).toMatch(/^pick-the-retry-backoff-2026-07-06-[0-9a-f]{4}$/);
  });

  test("two ids for the same question+date differ (random suffix)", () => {
    const now = new Date("2026-07-06T12:00:00Z");
    expect(buildDecisionId("same question", now)).not.toBe(buildDecisionId("same question", now));
  });
});

// ─── type guards ────────────────────────────────────────────────────────────────

describe("type guards", () => {
  test("isTier", () => {
    expect(isTier(0)).toBe(true);
    expect(isTier(2)).toBe(true);
    expect(isTier(3)).toBe(false);
    expect(isTier("1")).toBe(false);
  });
  test("isStakes / isStatus / isVerdict", () => {
    expect(isStakes("high")).toBe(true);
    expect(isStakes("huge")).toBe(false);
    expect(isStatus("resolved")).toBe(true);
    expect(isStatus("done")).toBe(false);
    expect(isVerdict("wrong-tier-high")).toBe(true);
    expect(isVerdict("maybe")).toBe(false);
  });
  test("isTerminal", () => {
    expect(isTerminal("archived")).toBe(true);
    expect(isTerminal("superseded")).toBe(true);
    expect(isTerminal("wontfix")).toBe(true);
    expect(isTerminal("filed")).toBe(false);
    expect(isTerminal("resolved")).toBe(false);
  });
  test("canTransition mirrors the table", () => {
    expect(canTransition("filed", "triaged")).toBe(true);
    expect(canTransition("filed", "enacted")).toBe(false);
    expect(canTransition("resolved", "reviewed")).toBe(true);
    expect(canTransition("reviewed", "deliberating")).toBe(false);
    expect(canTransition("archived", "filed")).toBe(false);
  });
  test("every terminal status has no outgoing transitions", () => {
    for (const s of ["archived", "superseded", "wontfix"] as const) {
      expect(LEGAL_TRANSITIONS[s]).toEqual([]);
    }
  });
});

// ─── filing ────────────────────────────────────────────────────────────────────

describe("fileDecision", () => {
  test("creates a manifest on disk with the expected shape", () => {
    const r = fileDecision(root, {
      question: "Adopt the docket?",
      tier: 2,
      stakes: "high",
      context: "recurring escalations",
      defaultTaken: "parked pending review",
      filedBy: "agent-Quill",
      filedById: "abc-123",
    });
    expect(r.ok).toBe(true);
    const m = r.manifest!;
    expect(m.status).toBe("filed");
    expect(m.tier).toBe(2);
    expect(m.stakes).toBe("high");
    expect(m.default_taken).toBe("parked pending review");
    expect(m.filed_by).toBe("agent-Quill");
    expect(existsSync(manifestPath(root, m.decision_id))).toBe(true);
    expect(readManifest(root, m.decision_id)?.question).toBe("Adopt the docket?");
  });

  test("writes a brief.md body when provided", () => {
    const id = file({ brief: "# Long brief\n\noptions and tradeoffs" });
    const briefPath = join(decisionBodyDir(root, id), "brief.md");
    expect(existsSync(briefPath)).toBe(true);
    expect(readFileSync(briefPath, "utf8")).toContain("Long brief");
  });

  test("rejects empty question, bad tier, bad stakes", () => {
    expect(fileDecision(root, { question: "  ", tier: 1, stakes: "small" }).ok).toBe(false);
    // @ts-expect-error deliberately invalid tier
    expect(fileDecision(root, { question: "q", tier: 5, stakes: "small" }).ok).toBe(false);
    // @ts-expect-error deliberately invalid stakes
    expect(fileDecision(root, { question: "q", tier: 1, stakes: "enormous" }).ok).toBe(false);
  });

  test("two filed decisions coexist as separate files (no shared index)", () => {
    const a = file();
    const b = file({ question: "A different question entirely" });
    expect(a).not.toBe(b);
    expect(listDecisions(root)).toHaveLength(2);
  });
});

// ─── transitions ────────────────────────────────────────────────────────────────

describe("lifecycle transitions", () => {
  test("full happy path filed→triaged→deliberating→resolved→enacted→reviewed→archived", () => {
    const id = file();
    expect(triageDecision(root, id, { tier: 0, stakes: "small" }).ok).toBe(true);
    expect(readManifest(root, id)?.tier).toBe(0);
    expect(claimDecision(root, id, "agent-Sweeper").ok).toBe(true);
    expect(readManifest(root, id)?.status).toBe("deliberating");
    expect(resolveDecision(root, id, goodResolution).ok).toBe(true);
    expect(enactDecision(root, id).ok).toBe(true);
    expect(reviewDecision(root, id, { verdict: "ratified" }).ok).toBe(true);
    expect(archiveDecision(root, id, "docs/decisions.md#foo").ok).toBe(true);
    expect(readManifest(root, id)?.status).toBe("archived");
    expect(readManifest(root, id)?.graduated_to).toBe("docs/decisions.md#foo");
  });

  test("illegal transition is rejected with a reason", () => {
    const id = file();
    const r = enactDecision(root, id); // filed → enacted is illegal
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("illegal transition filed → enacted");
  });

  test("terminal states are read-only", () => {
    const id = file();
    expect(wontfixDecision(root, id, "duplicate").ok).toBe(true);
    expect(readManifest(root, id)?.status).toBe("wontfix");
    expect(readManifest(root, id)?.wontfix_reason).toBe("duplicate");
    // any further mutation on a terminal decision fails
    expect(claimDecision(root, id, "agent-X").ok).toBe(false);
    expect(triageDecision(root, id, { tier: 0 }).ok).toBe(false);
  });

  test("supersede is reachable from a non-terminal state and records the superseding id", () => {
    const id = file();
    claimDecision(root, id, "agent-A");
    const r = supersedeDecision(root, id, "newer-decision-id");
    expect(r.ok).toBe(true);
    expect(readManifest(root, id)?.status).toBe("superseded");
    expect(readManifest(root, id)?.superseded_by).toBe("newer-decision-id");
  });

  test("deliberating can re-triage (sweeper self-triage safeguard)", () => {
    const id = file();
    claimDecision(root, id, "agent-Sweeper");
    const r = triageDecision(root, id, { tier: 2, stakes: "high" });
    expect(r.ok).toBe(true);
    expect(readManifest(root, id)?.tier).toBe(2);
    expect(readManifest(root, id)?.status).toBe("triaged");
  });

  test("escalateToCouncil links a council and moves to deliberating", () => {
    const id = file();
    const r = escalateToCouncil(root, id, "review-the-thing-2026-07-06-abcd");
    expect(r.ok).toBe(true);
    expect(readManifest(root, id)?.council_id).toBe("review-the-thing-2026-07-06-abcd");
    expect(readManifest(root, id)?.status).toBe("deliberating");
  });

  test("mutating a missing decision fails cleanly", () => {
    expect(claimDecision(root, "does-not-exist", "agent-X").ok).toBe(false);
  });
});

// ─── resolution: evidence required ────────────────────────────────────────────────

describe("resolveDecision evidence guard", () => {
  test("accepts a resolution with ≥1 evidence citation", () => {
    const id = file();
    claimDecision(root, id, "agent-Sweeper");
    const r = resolveDecision(root, id, goodResolution);
    expect(r.ok).toBe(true);
    expect(r.manifest?.resolution?.evidence).toHaveLength(2);
    expect(r.manifest?.resolution?.resolved_at).toBeTruthy();
  });

  test("bounces an evidence-free resolution", () => {
    const id = file();
    claimDecision(root, id, "agent-Sweeper");
    const r = resolveDecision(root, id, { ...goodResolution, evidence: [] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("evidence");
  });

  test("bounces whitespace-only evidence (stripped to empty)", () => {
    const id = file();
    claimDecision(root, id, "agent-Sweeper");
    const r = resolveDecision(root, id, { ...goodResolution, evidence: ["  ", ""] });
    expect(r.ok).toBe(false);
  });

  test("requires a recommendation and resolved_by", () => {
    const id = file();
    claimDecision(root, id, "agent-Sweeper");
    expect(resolveDecision(root, id, { ...goodResolution, recommendation: " " }).ok).toBe(false);
    expect(resolveDecision(root, id, { ...goodResolution, resolved_by: "" }).ok).toBe(false);
  });
});

// ─── review ──────────────────────────────────────────────────────────────────────

describe("reviewDecision", () => {
  function resolved(): string {
    const id = file();
    claimDecision(root, id, "agent-Sweeper");
    resolveDecision(root, id, goodResolution);
    return id;
  }
  test("records a valid verdict", () => {
    const id = resolved();
    const r = reviewDecision(root, id, {
      verdict: "overridden",
      note: "wrong call on partition key",
    });
    expect(r.ok).toBe(true);
    expect(readManifest(root, id)?.review?.verdict).toBe("overridden");
    expect(readManifest(root, id)?.review?.note).toContain("partition key");
  });
  test("accepts wrong-tier verdicts (triage calibration signal)", () => {
    expect(reviewDecision(root, resolved(), { verdict: "wrong-tier-low" }).ok).toBe(true);
    expect(reviewDecision(root, resolved(), { verdict: "wrong-tier-high" }).ok).toBe(true);
  });
  test("rejects an unknown verdict", () => {
    // @ts-expect-error deliberately invalid verdict
    expect(reviewDecision(root, resolved(), { verdict: "meh" }).ok).toBe(false);
  });
});

// ─── archive move ─────────────────────────────────────────────────────────────────

describe("archiveDecision", () => {
  function toArchivable(): string {
    const id = file({ brief: "the brief" });
    claimDecision(root, id, "agent-Sweeper");
    resolveDecision(root, id, goodResolution);
    reviewDecision(root, id, { verdict: "ratified" });
    return id;
  }
  test("moves manifest + body dir into archive/ and stays readable", () => {
    const id = toArchivable();
    expect(archiveDecision(root, id).ok).toBe(true);
    expect(existsSync(manifestPath(root, id))).toBe(false);
    expect(existsSync(archivedManifestPath(root, id))).toBe(true);
    // body dir moved under archive/
    expect(existsSync(join(root, ".harnery", "decisions", "archive", id, "brief.md"))).toBe(true);
    // readManifest transparently finds the archived copy
    expect(readManifest(root, id)?.status).toBe("archived");
    const detail = showDecision(root, id);
    expect(detail?.archived).toBe(true);
    expect(detail?.bodies.some((b) => b.name === "brief.md")).toBe(true);
  });
  test("archived decisions are excluded from the default list but included with includeArchived", () => {
    const id = toArchivable();
    archiveDecision(root, id);
    expect(listDecisions(root)).toHaveLength(0);
    expect(listDecisions(root, { includeArchived: true })).toHaveLength(1);
  });
});

// ─── list filters ──────────────────────────────────────────────────────────────────

describe("listDecisions", () => {
  test("filters by status / tier / stakes / openOnly and sorts filed_at desc", () => {
    const early = file({ question: "first one", now: new Date("2026-07-01T00:00:00Z") } as never);
    const late = fileDecision(root, {
      question: "second one later",
      tier: 2,
      stakes: "high",
      now: new Date("2026-07-05T00:00:00Z"),
    }).manifest!.decision_id;
    wontfixDecision(root, early, "nope");

    const all = listDecisions(root);
    expect(all).toHaveLength(2);
    expect(all[0].decision_id).toBe(late); // newest first

    expect(listDecisions(root, { tier: 2 }).map((d) => d.decision_id)).toEqual([late]);
    expect(listDecisions(root, { stakes: "high" }).map((d) => d.decision_id)).toEqual([late]);
    expect(listDecisions(root, { status: "wontfix" }).map((d) => d.decision_id)).toEqual([early]);
    expect(listDecisions(root, { openOnly: true }).map((d) => d.decision_id)).toEqual([late]);
  });

  test("skips unparseable manifests without throwing", () => {
    file();
    writeFileSync(join(root, ".harnery", "decisions", "garbage.json"), "{ not json", "utf8");
    expect(() => listDecisions(root)).not.toThrow();
    expect(listDecisions(root)).toHaveLength(1);
  });
});

// ─── search ──────────────────────────────────────────────────────────────────────────

describe("searchDecisions", () => {
  test("finds substrings across question, context, resolution and body; case-insensitive", () => {
    const id = file({
      question: "Which timezone for the daily-exec report?",
      context: "Joe's sheet uses America/Chicago",
      brief: "options include UTC and NY",
    });
    claimDecision(root, id, "agent-Sweeper");
    resolveDecision(root, id, {
      recommendation: "Use America/New_York for order bucketing",
      evidence: ["fct_orders uses NY day boundaries"],
      resolved_by: "agent-Sweeper",
    });

    expect(searchDecisions(root, "TIMEZONE")).toHaveLength(1); // question, case-insensitive
    expect(searchDecisions(root, "chicago")[0]?.where).toBe("context");
    expect(searchDecisions(root, "new_york")[0]?.where).toBe("resolution");
    expect(searchDecisions(root, "options include")[0]?.where).toBe("body");
    expect(searchDecisions(root, "nonexistent-token")).toHaveLength(0);
  });

  test("empty query returns nothing", () => {
    file();
    expect(searchDecisions(root, "   ")).toHaveLength(0);
  });

  test("searches archived precedent too", () => {
    const id = file({ question: "precedent about retry backoff" });
    claimDecision(root, id, "agent-Sweeper");
    resolveDecision(root, id, goodResolution);
    reviewDecision(root, id, { verdict: "ratified" });
    archiveDecision(root, id, "AGENTS.md#retry");
    expect(searchDecisions(root, "retry backoff")).toHaveLength(1);
  });
});

// ─── atomic write / schema ─────────────────────────────────────────────────────────────

describe("persistence", () => {
  test("writeManifest / readManifest round-trip", () => {
    const id = file();
    const m = readManifest(root, id)!;
    m.context = "edited context";
    writeManifest(root, m);
    expect(readManifest(root, id)?.context).toBe("edited context");
    // written as pretty JSON with a trailing newline
    const raw = readFileSync(manifestPath(root, id), "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(raw).toContain('\n  "decision_id"');
  });

  test("readManifest throws on an unsupported schema_version", () => {
    const id = file();
    const bad: DecisionManifest = { ...readManifest(root, id)!, schema_version: 99 as never };
    writeFileSync(manifestPath(root, id), JSON.stringify(bad), "utf8");
    expect(() => readManifest(root, id)).toThrow(/schema_version/);
  });

  test("schema version constant is 1", () => {
    expect(DECISION_SCHEMA_VERSION).toBe(1);
  });
});
