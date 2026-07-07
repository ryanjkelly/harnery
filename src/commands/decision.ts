import { existsSync, readFileSync } from "node:fs";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  emitCanonical,
  monorepoRoot,
  normalizeHarness,
  readHeartbeat,
  resolveOwner,
} from "../core/agents/index.ts";
import { resolveBinName } from "../core/config.ts";
import {
  claimDecision,
  DECISION_STAKES,
  type DecisionManifest,
  type DecisionStakes,
  type DecisionStatus,
  type DecisionTier,
  fileDecision,
  isStakes,
  isStatus,
  isTier,
  isVerdict,
  listDecisions,
  type ReviewVerdict,
  resolveDecision,
  reviewDecision,
  searchDecisions,
  showDecision,
  triageDecision,
} from "../lib/decision/index.ts";

/**
 * `harn decision`: the decision docket — a persistent queue of decisions an
 * agent would otherwise route to a human, carried through triage → deliberation
 * → an evidence-cited resolution → async review.
 *
 * The engine is generic: it stores `tier` (0/1/2) + `stakes` but never decides
 * what belongs in which tier — that's host policy, applied by the filing agent
 * (for a host, via its own /decide skill + rubric).
 */
let emit: EmitContext;

export function registerDecisionCommand(program: Command, emitParam: EmitContext): void {
  emit = emitParam;
  const bin = () => resolveBinName();
  const root = program
    .command("decision")
    .alias("decisions")
    .description(
      "Decision docket: file a decision an agent would otherwise escalate, " +
        "deliberate it, resolve with cited evidence, review async.",
    );

  // ── file ─────────────────────────────────────────────────────────────────
  root
    .command("file <question...>")
    .description("File a decision into the docket. Tier/stakes are the filer's triage call.")
    .option("--tier <0|1|2>", "Human-involvement tier (0 none, 1 review, 2 decide-with-brief)", "2")
    .option("--stakes <small|medium|high>", "Reversal cost / blast radius", "medium")
    .option("--context <text>", "Why it matters, what's blocked")
    .option("--default-taken <text>", "What you proceeded with (always-proceed, tier 0/1)")
    .option("--brief <path>", "Path to a markdown file with the long-form brief")
    .option("--filed-by <name>", "Filer agent name (else resolved from heartbeat)")
    .action((question: string[], opts: FileOpts) => {
      const coordRoot = coordRootOrExit();
      const tier = parseTier(opts.tier);
      const stakes = parseStakes(opts.stakes);
      let brief: string | undefined;
      if (opts.brief) {
        if (!existsSync(opts.brief)) {
          emit.error({ code: "no_brief_file", message: `brief file not found: ${opts.brief}` });
          process.exit(1);
        }
        brief = readFileSync(opts.brief, "utf8");
      }
      const owner = resolveOwner();
      const hb = owner ? readHeartbeat(owner) : null;
      const r = fileDecision(coordRoot, {
        question: question.join(" "),
        tier,
        stakes,
        context: opts.context,
        defaultTaken: opts.defaultTaken,
        brief,
        filedBy: opts.filedBy ?? hb?.name ?? undefined,
        filedById: owner ?? undefined,
      });
      if (!r.ok) return fail("file_failed", r.reason);
      emitDecisionEvent("decision.filed", {
        decision_id: r.manifest!.decision_id,
        tier,
        stakes,
      });
      emit.data(r.manifest);
    });

  // ── list ─────────────────────────────────────────────────────────────────
  root
    .command("list")
    .description("List docket decisions (default: active only, newest first).")
    .option("--status <status>", "Filter by status")
    .option("--tier <0|1|2>", "Filter by tier")
    .option("--stakes <small|medium|high>", "Filter by stakes")
    .option("--open", "Only non-terminal decisions (the live queue)")
    .option("--archived", "Include archived (graduated/terminal) decisions")
    .action((opts: ListOpts) => {
      const coordRoot = coordRootOrExit();
      const status = opts.status ? parseStatus(opts.status) : undefined;
      const tier = opts.tier !== undefined ? parseTier(opts.tier) : undefined;
      const stakes = opts.stakes ? parseStakes(opts.stakes) : undefined;
      const rows = listDecisions(coordRoot, {
        status,
        tier,
        stakes,
        openOnly: opts.open,
        includeArchived: opts.archived,
      }).map(summarize);
      emit.data({
        rows,
        meta: {
          total: rows.length,
          filter: { status, tier, stakes, open: !!opts.open, archived: !!opts.archived },
        },
      });
    });

  // ── show ─────────────────────────────────────────────────────────────────
  root
    .command("show <id>")
    .description("Show one decision: manifest + long-form bodies.")
    .action((id: string) => {
      const coordRoot = coordRootOrExit();
      const detail = showDecision(coordRoot, id);
      if (!detail) return fail("not_found", `no decision "${id}"`);
      emit.data(detail);
    });

  // ── search ───────────────────────────────────────────────────────────────
  root
    .command("search <query...>")
    .description("Substring search over questions, context, resolutions, bodies (incl. archive).")
    .action((query: string[]) => {
      const coordRoot = coordRootOrExit();
      const hits = searchDecisions(coordRoot, query.join(" ")).map((h) => ({
        ...summarize(h.manifest),
        where: h.where,
        snippet: h.snippet,
      }));
      emit.data({ rows: hits, meta: { total: hits.length, query: query.join(" ") } });
    });

  // ── claim ────────────────────────────────────────────────────────────────
  root
    .command("claim <id>")
    .description("Claim a decision for deliberation (last-writer-wins).")
    .option("--owner <id>", "Claim as this owner (else the current agent)")
    .action((id: string, opts: { owner?: string }) => {
      const coordRoot = coordRootOrExit();
      const owner = opts.owner ?? resolveOwner();
      if (!owner) {
        return fail(
          "no_owner",
          `not in an agent session; pass --owner or run \`${bin()} agents whoami\` to check`,
        );
      }
      const r = claimDecision(coordRoot, id, owner);
      if (!r.ok) return fail("claim_failed", r.reason);
      emit.data(r.manifest);
    });

  // ── resolve ──────────────────────────────────────────────────────────────
  root
    .command("resolve <id>")
    .description("Resolve a decision. Evidence (≥1 citation) is required.")
    .requiredOption("--recommendation <text>", "The recommendation")
    .option(
      "--evidence <text>",
      "A cited fact (query run, file read, cost computed). Repeatable; ≥1 required.",
      collect,
      [] as string[],
    )
    .option("--confidence <text>", "Confidence in the recommendation")
    .option("--reversal-cost <text>", "Cost to reverse if wrong")
    .option("--wrong-if <text>", "What would make this wrong (pre-mortem)")
    .option("--revisit-when <text>", "Revisit trigger")
    .option("--resolved-by <name>", "Resolver (else the current agent)")
    .action((id: string, opts: ResolveOpts) => {
      const coordRoot = coordRootOrExit();
      const owner = resolveOwner();
      const resolvedBy = opts.resolvedBy ?? (owner ? readHeartbeat(owner)?.name : undefined);
      if (!resolvedBy) {
        return fail("no_resolver", "pass --resolved-by (no agent session to infer it from)");
      }
      const r = resolveDecision(coordRoot, id, {
        recommendation: opts.recommendation,
        evidence: opts.evidence,
        confidence: opts.confidence,
        reversal_cost: opts.reversalCost,
        wrong_if: opts.wrongIf,
        revisit_when: opts.revisitWhen,
        resolved_by: resolvedBy,
      });
      if (!r.ok) return fail("resolve_failed", r.reason);
      emitDecisionEvent("decision.resolved", {
        decision_id: id,
        tier: r.manifest!.tier,
        stakes: r.manifest!.stakes,
        confidence: opts.confidence ?? null,
      });
      emit.data(r.manifest);
    });

  // ── review ───────────────────────────────────────────────────────────────
  root
    .command("review <id>")
    .description("Record a review verdict (calibration, not approval — work already proceeded).")
    .requiredOption(
      "--verdict <verdict>",
      "ratified | overridden | wrong-tier-high | wrong-tier-low",
    )
    .option("--note <text>", "Reviewer note")
    .action((id: string, opts: { verdict: string; note?: string }) => {
      const coordRoot = coordRootOrExit();
      if (!isVerdict(opts.verdict)) {
        return fail(
          "bad_verdict",
          "verdict must be: ratified | overridden | wrong-tier-high | wrong-tier-low",
        );
      }
      const r = reviewDecision(coordRoot, id, {
        verdict: opts.verdict as ReviewVerdict,
        note: opts.note,
      });
      if (!r.ok) return fail("review_failed", r.reason);
      emitDecisionEvent("decision.reviewed", {
        decision_id: id,
        verdict: opts.verdict,
        tier: r.manifest!.tier,
      });
      emit.data(r.manifest);
    });

  // ── triage ─────────────────────────────────────────────────────────────────
  // Re-set tier/stakes on an already-filed decision (e.g. after a sweeper or
  // reviewer flags a wrong-tier). Cheap enough to surface in phase 1.
  root
    .command("triage <id>")
    .description("Adjust an already-filed decision's tier/stakes.")
    .option("--tier <0|1|2>", "New tier")
    .option("--stakes <small|medium|high>", "New stakes")
    .action((id: string, opts: { tier?: string; stakes?: string }) => {
      const coordRoot = coordRootOrExit();
      if (opts.tier === undefined && opts.stakes === undefined) {
        return fail("nothing_to_do", "pass --tier and/or --stakes");
      }
      const r = triageDecision(coordRoot, id, {
        tier: opts.tier !== undefined ? parseTier(opts.tier) : undefined,
        stakes: opts.stakes !== undefined ? parseStakes(opts.stakes) : undefined,
      });
      if (!r.ok) return fail("triage_failed", r.reason);
      emit.data(r.manifest);
    });
}

// ─── option types ────────────────────────────────────────────────────────────

interface FileOpts {
  tier: string;
  stakes: string;
  context?: string;
  defaultTaken?: string;
  brief?: string;
  filedBy?: string;
}
interface ListOpts {
  status?: string;
  tier?: string;
  stakes?: string;
  open?: boolean;
  archived?: boolean;
}
interface ResolveOpts {
  recommendation: string;
  evidence: string[];
  confidence?: string;
  reversalCost?: string;
  wrongIf?: string;
  revisitWhen?: string;
  resolvedBy?: string;
}

// ─── helpers ───────────────────────────────────────────────────────────────────

function coordRootOrExit(): string {
  const root = monorepoRoot();
  if (!root) {
    emit.error({
      code: "no_coord_root",
      message: "not in a coord-aware repo (no .harnery/ found)",
    });
    process.exit(1);
  }
  return root;
}

function fail(code: string, message?: string): never {
  emit.error({ code, message: message ?? code });
  process.exit(1);
}

function parseTier(raw: string): DecisionTier {
  const n = Number.parseInt(raw, 10);
  if (!isTier(n)) fail("bad_tier", `tier must be 0, 1, or 2 (got "${raw}")`);
  return n as DecisionTier;
}

function parseStakes(raw: string): DecisionStakes {
  if (!isStakes(raw))
    fail("bad_stakes", `stakes must be ${DECISION_STAKES.join(" | ")} (got "${raw}")`);
  return raw as DecisionStakes;
}

function parseStatus(raw: string): DecisionStatus {
  if (!isStatus(raw)) fail("bad_status", `unknown status "${raw}"`);
  return raw as DecisionStatus;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** Compact row for list/search output — the full manifest is available via `show`. */
function summarize(m: DecisionManifest): Record<string, unknown> {
  return {
    decision_id: m.decision_id,
    status: m.status,
    tier: m.tier,
    stakes: m.stakes,
    question: m.question,
    filed_by: m.filed_by ?? null,
    filed_at: m.filed_at,
    claimed_by: m.claimed_by ?? null,
    resolved: !!m.resolution,
    reviewed: !!m.review,
    graduated_to: m.graduated_to ?? null,
  };
}

/**
 * Emit a canonical `decision.*` event. Soft: no-ops when there's no agent
 * session to attribute it to (operator-side filing). Powers the docket metrics
 * without new telemetry plumbing.
 */
function emitDecisionEvent(type: string, data: Record<string, unknown>): void {
  const owner = resolveOwner();
  if (!owner) return;
  const hb = readHeartbeat(owner);
  emitCanonical({
    type,
    owner,
    session: hb?.session_id ?? owner,
    harness: normalizeHarness(hb?.platform),
    data,
  });
}
