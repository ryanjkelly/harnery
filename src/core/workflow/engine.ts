/**
 * Workflow engine: loads a workflow script (plain JS, `export default
 * async (ctx) => …`), injects the ctx API, enforces the caps, journals every
 * step to `.harnery/workflows/<run-id>/journal.jsonl`, and returns a RunReport.
 *
 * Guarantees the engine makes (the pitch, in code):
 *   - **Bounded**: hard total-agent ceiling + bounded parallel() concurrency.
 *     A runaway loop hits `maxAgents` and the run fails loud, not silently.
 *   - **Terminating**: the run is over when the script's default export
 *     returns. There is no recursive self-spawning path: subagents are leaf
 *     processes; only the top-level script can spawn.
 *   - **Schema-gated**: with `schema`, an agent's reply must strict-parse and
 *     validate; failures re-prompt with the validation errors appended, up to
 *     `maxAttempts`, then throw. Routing decisions read validated fields, so
 *     the deterministic script — not a model — decides what runs next.
 *   - **Journaled**: every stage/agent start+end lands in the run journal with
 *     cost, duration, and child session id (the resume + web-UI substrate).
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { snapshotRepo } from "../context/index.ts";
import { type BillingProbe, probeBilling } from "./billing.ts";
import {
  buildWorkflowProof,
  createEvidenceRecord,
  digestResult,
  normalizeWorkflowMeta,
  writeWorkflowProof,
} from "./proof.ts";
import type {
  AgentOpts,
  EngineOpts,
  HarnessName,
  RunReport,
  SpawnResult,
  WorkflowAgentProof,
  WorkflowContext,
  WorkflowEvidenceRecord,
  WorkflowModule,
  WorkflowProof,
} from "./types.ts";
import { WORKFLOW_PROOF_SCHEMA_VERSION } from "./types.ts";
import { parseStageOutput, validateAgainstSchema } from "./validate.ts";

const DEFAULT_MAX_AGENTS = 50;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TURNS = 25;

export class WorkflowRunError extends Error {
  readonly runId: string;
  readonly proofPath: string;

  constructor(message: string, runId: string, proofPath: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "WorkflowRunError";
    this.runId = runId;
    this.proofPath = proofPath;
  }
}

export async function runWorkflow(scriptPath: string, opts: EngineOpts): Promise<RunReport> {
  const absScript = isAbsolute(scriptPath) ? scriptPath : resolve(process.cwd(), scriptPath);
  const mod = (await import(pathToFileURL(absScript).href)) as WorkflowModule;
  if (typeof mod.default !== "function") {
    throw new Error(`${scriptPath}: workflow script must \`export default async (ctx) => …\``);
  }
  const fallbackName = scriptPath.replace(/^.*\//, "").replace(/\.[cm]?js$/, "");
  const meta = normalizeWorkflowMeta(mod.meta, fallbackName);
  const name = meta.name;

  const runId = `wf-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = join(opts.coordRoot, ".harnery", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const journalPath = join(runDir, "journal.jsonl");
  const proofPath = join(runDir, "proof.json");

  const maxAgents = opts.maxAgents ?? DEFAULT_MAX_AGENTS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const cwd = opts.cwd ?? opts.coordRoot;
  const log = opts.onLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  const defaultHarness: HarnessName = opts.defaultHarness ?? "claude-code";
  const repoBefore = snapshotRepo(cwd);

  // Per-child fixed context overhead: children spawn in `cwd` and load its
  // repo-instructions file into their system prompt, cache-writing it once
  // per child. A fan-out multiplies this, so surface it BEFORE the burn.
  const contextTokensPerChildEstimate = estimateInstructionTokens(cwd);
  if (contextTokensPerChildEstimate > 0) {
    log(
      `[context] each child cache-writes ~${Math.round(contextTokensPerChildEstimate / 1000)}K tokens of repo ` +
        `instructions from ${cwd}; a fan-out multiplies this per agent`,
    );
  }

  // Resume: journaled results of a prior run, keyed by agent-call identity.
  const resumeCache = opts.resumeFrom
    ? loadResumeCache(opts.coordRoot, opts.resumeFrom)
    : new Map<string, { kind: "json" | "text"; value: unknown }>();

  let agentsSpawned = 0;
  let agentsCached = 0;
  let costUsd = 0;
  let currentStage = "";
  let agentSeq = 0;
  let evidenceSeq = 0;
  const billingProbed = new Map<HarnessName, BillingProbe>();
  const agentProofs = new Map<string, WorkflowAgentProof>();
  const evidenceRecords: WorkflowEvidenceRecord[] = [];
  const acceptanceIds = new Set(meta.acceptance.map((criterion) => criterion.id));

  const journal = (event: string, data: Record<string, unknown>): void => {
    const line = JSON.stringify({
      schema_version: WORKFLOW_PROOF_SCHEMA_VERSION,
      run_id: runId,
      ts: new Date().toISOString(),
      event,
      stage: currentStage,
      ...data,
    });
    appendFileSync(journalPath, `${line}\n`, "utf8");
  };

  // Bounded concurrency gate shared by every spawn in the run — direct
  // `agent()` calls and `parallel()` thunks draw from the same slot pool, so
  // the cap holds even when a script nests parallel() inside loops.
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (inFlight < concurrency) {
      inFlight++;
      return;
    }
    await new Promise<void>((res) => waiters.push(res));
    inFlight++;
  };
  const release = (): void => {
    inFlight--;
    waiters.shift()?.();
  };

  const agent = async (prompt: string, agentOpts: AgentOpts = {}): Promise<unknown> => {
    const harness = agentOpts.harness ?? defaultHarness;
    const spawner = opts.spawners[harness];
    if (!spawner) {
      throw new Error(
        `no spawner registered for harness "${harness}" (registered: ${Object.keys(opts.spawners).join(", ") || "none"})`,
      );
    }
    const id = `a${++agentSeq}`;
    const label = agentOpts.label ?? `${prompt.slice(0, 60).replace(/\s+/g, " ")}…`;
    const proofLabel = agentOpts.label ?? id;
    const maxAttempts = agentOpts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const agentProof: WorkflowAgentProof = {
      id,
      label: proofLabel,
      stage: currentStage || undefined,
      harness,
      model: agentOpts.model,
      status: "failed",
      attempts: 0,
      duration_ms: 0,
    };
    agentProofs.set(id, agentProof);

    // Call identity for resume: same stage + harness + model + effort + turns + schema
    // + ORIGINAL prompt → same key. Retry-mutated prompts never enter the key.
    const key = agentCallKey(currentStage, harness, agentOpts, prompt);
    const cached = resumeCache.get(key);
    if (cached) {
      agentsCached++;
      agentProof.status = "cached";
      agentProof.result = digestResult(cached.value, cached.kind);
      journal("agent.cached", {
        id,
        label,
        key,
        harness,
        model: agentOpts.model ?? null,
        kind: cached.kind,
      });
      log(
        `[${name}] ${currentStage || "(no stage)"} → ${id} ${label} (cached from ${opts.resumeFrom})`,
      );
      return cached.value;
    }

    // Billing safeguard: on a harness's FIRST spawn this run, classify which
    // auth its children will use and refuse the silent-override state (an
    // exported API key shadowing a stored subscription login) unless the
    // caller explicitly opted into API billing. Cached agents never reach
    // this — no spawn, no billing.
    if (!billingProbed.has(harness)) {
      const probe = (opts.probeBilling ?? probeBilling)(harness);
      billingProbed.set(harness, probe);
      journal("billing.probe", {
        harness,
        mode: opts.subscriptionOnly ? "subscription" : probe.mode,
        api_key_source: probe.apiKeySource,
        login: probe.login,
        subscription_only: Boolean(opts.subscriptionOnly),
      });
      if (opts.subscriptionOnly) {
        if (probe.login === "absent") {
          throw new Error(
            `subscription-only: no stored login detected for ${harness}; ` +
              `log the harness CLI in (or drop --subscription-only for a key-only host)`,
          );
        }
        log(`[billing] ${harness}: subscription-only (API-key vars scrubbed from child env)`);
      } else if (probe.mode === "api-key-override" && !opts.allowApiBilling) {
        throw new Error(
          `${probe.apiKeySource} is set AND a stored ${harness} login exists — the key silently ` +
            `overrides your subscription auth, so children would bill per-token API rates. ` +
            `Either unset ${probe.apiKeySource}, run with --subscription-only to scrub it from ` +
            `child envs, or pass --allow-api-billing if API billing is intended`,
        );
      } else if (probe.mode === "api-key") {
        log(
          `[billing] ${harness}: API-key billing (${probe.apiKeySource}; no stored login detected) — ` +
            `children bill per-token rates`,
        );
      } else if (probe.mode === "api-key-override") {
        log(
          `[billing] ${harness}: API-key billing (--allow-api-billing; key overrides stored login)`,
        );
      } else {
        log(`[billing] ${harness}: subscription login`);
      }
    }

    if (agentsSpawned >= maxAgents) {
      agentProof.error = `workflow agent cap reached (${maxAgents})`;
      throw new Error(
        `workflow agent cap reached (${maxAgents}); raise --max-agents deliberately if the fan-out is intended`,
      );
    }
    agentsSpawned++;

    await acquire();
    try {
      journal("agent.start", {
        id,
        label,
        key,
        harness,
        model: agentOpts.model ?? null,
        effort: agentOpts.effort ?? null,
      });
      log(`[${name}] ${currentStage || "(no stage)"} → ${id} [${harness}] ${label}`);

      let attemptPrompt = prompt;
      let last: SpawnResult | null = null;
      let agentCostUsd = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        last = await spawner({
          prompt: attemptPrompt,
          model: agentOpts.model,
          effort: agentOpts.effort,
          timeoutMs: agentOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxTurns: agentOpts.maxTurns ?? DEFAULT_MAX_TURNS,
          cwd,
          runId,
          subscriptionOnly: opts.subscriptionOnly,
        });
        agentProof.attempts = attempt;
        agentProof.duration_ms += last.durationMs;
        agentCostUsd += last.costUsd ?? 0;
        costUsd += last.costUsd ?? 0;

        if (!last.ok) {
          journal("agent.attempt_failed", { id, attempt, error: last.error });
          continue; // spawn-level failure: retry with the original prompt
        }
        if (!agentOpts.schema) {
          agentProof.status = "succeeded";
          agentProof.cost_usd =
            agentCostUsd > 0 || last.costUsd !== undefined ? agentCostUsd : undefined;
          agentProof.session_id = last.sessionId;
          agentProof.result = digestResult(last.text, "text");
          journal("agent.end", {
            id,
            key,
            attempts: attempt,
            cost_usd: last.costUsd,
            duration_ms: last.durationMs,
            session_id: last.sessionId,
            result_kind: "text",
            result: last.text,
          });
          return last.text;
        }

        const parsed = parseStageOutput(last.text);
        const problems =
          parsed.error !== undefined
            ? [parsed.error]
            : validateAgainstSchema(parsed.value, agentOpts.schema);
        if (problems.length === 0) {
          agentProof.status = "succeeded";
          agentProof.cost_usd =
            agentCostUsd > 0 || last.costUsd !== undefined ? agentCostUsd : undefined;
          agentProof.session_id = last.sessionId;
          agentProof.result = digestResult(parsed.value, "json");
          journal("agent.end", {
            id,
            key,
            attempts: attempt,
            cost_usd: last.costUsd,
            duration_ms: last.durationMs,
            session_id: last.sessionId,
            result_kind: "json",
            result: parsed.value,
          });
          return parsed.value;
        }

        journal("agent.schema_retry", { id, attempt, problems });
        // Feed the validation failure back verbatim — the retry prompt carries
        // exactly what was wrong, which is what makes bounded retry converge.
        attemptPrompt =
          `${prompt}\n\nYour previous reply failed validation:\n` +
          `${problems.map((p) => `  - ${p}`).join("\n")}\n` +
          `Reply with ONLY the corrected JSON object. No prose, no code fences.`;
      }

      const reason = last?.ok
        ? `schema validation failed after ${maxAttempts} attempt(s)`
        : (last?.error ?? "spawn failed");
      agentProof.cost_usd =
        agentCostUsd > 0 || last?.costUsd !== undefined ? agentCostUsd : undefined;
      agentProof.session_id = last?.sessionId;
      agentProof.error = reason;
      journal("agent.failed", { id, error: reason });
      throw new Error(`agent ${proofLabel}: ${reason}`);
    } catch (error) {
      agentProof.error ??= (error as Error).message;
      throw error;
    } finally {
      release();
    }
  };

  const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> => {
    // Fire everything; the shared slot pool inside agent() bounds real
    // concurrency. A rejected thunk lands as null so one bad item can't kill
    // the batch — the script filters and routes.
    return Promise.all(
      thunks.map((t) =>
        t().catch((err: unknown) => {
          journal("parallel.item_failed", { error: (err as Error).message });
          return null;
        }),
      ),
    );
  };

  const stage = (title: string): void => {
    currentStage = title;
    journal("stage.start", { title });
    log(`[${name}] ── stage: ${title}`);
  };

  const evidence = (input: Parameters<WorkflowContext["evidence"]>[0]): string => {
    const record = createEvidenceRecord({
      value: input,
      sequence: evidenceSeq + 1,
      acceptanceIds,
      stage: currentStage || undefined,
    });
    evidenceSeq++;
    evidenceRecords.push(record);
    journal("evidence.recorded", { ...record });
    return record.id;
  };

  const ctx: WorkflowContext = { agent, parallel, stage, log, evidence };

  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  journal("run.start", {
    name,
    script: absScript,
    objective: meta.objective ?? null,
    acceptance: meta.acceptance,
    max_agents: maxAgents,
    concurrency,
  });
  try {
    const result = await mod.default(ctx);
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    journal("run.end", {
      ok: true,
      agents: agentsSpawned,
      cached: agentsCached,
      cost_usd: round4(costUsd),
      duration_ms: durationMs,
    });
    let proof: WorkflowProof;
    try {
      proof = buildWorkflowProof({
        runId,
        meta,
        status: "succeeded",
        startedAt,
        endedAt,
        durationMs,
        journalPath,
        before: repoBefore,
        after: snapshotRepo(cwd),
        agents: Array.from(agentProofs.values()),
        evidence: evidenceRecords,
        harnessEvidence: opts.harnessEvidence,
        result,
      });
      writeWorkflowProof(proofPath, proof);
    } catch (error) {
      throw new WorkflowRunError(
        `workflow completed but its proof packet could not be written: ${(error as Error).message}`,
        runId,
        proofPath,
        error,
      );
    }
    const report: RunReport = {
      runId,
      name,
      result,
      agentsSpawned,
      agentsCached,
      costUsd: round4(costUsd),
      durationMs,
      journalPath,
      proofPath,
      acceptance: proof.acceptance.summary,
      contextTokensPerChildEstimate,
      billing: Array.from(billingProbed.values()).map((p) => ({
        harness: p.harness,
        mode: opts.subscriptionOnly ? "subscription" : p.mode,
      })),
    };
    return report;
  } catch (err) {
    if (err instanceof WorkflowRunError) throw err;
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    journal("run.end", {
      ok: false,
      error: (err as Error).message,
      agents: agentsSpawned,
      cached: agentsCached,
      cost_usd: round4(costUsd),
      duration_ms: durationMs,
    });
    try {
      const proof = buildWorkflowProof({
        runId,
        meta,
        status: "failed",
        startedAt,
        endedAt,
        durationMs,
        journalPath,
        before: repoBefore,
        after: snapshotRepo(cwd),
        agents: Array.from(agentProofs.values()),
        evidence: evidenceRecords,
        harnessEvidence: opts.harnessEvidence,
        error: (err as Error).message,
      });
      writeWorkflowProof(proofPath, proof);
    } catch (proofError) {
      throw new WorkflowRunError(
        `${(err as Error).message}; proof packet write also failed: ${(proofError as Error).message}`,
        runId,
        proofPath,
        err,
      );
    }
    throw new WorkflowRunError((err as Error).message, runId, proofPath, err);
  }
}

/** Stable identity for one agent() call, for the resume cache. The ORIGINAL
 * prompt (never a retry-mutated one) plus everything that changes behavior. */
function agentCallKey(
  stage: string,
  harness: string,
  agentOpts: AgentOpts,
  prompt: string,
): string {
  const basis = JSON.stringify([
    stage,
    harness,
    agentOpts.model ?? null,
    agentOpts.effort ?? null,
    agentOpts.maxTurns ?? DEFAULT_MAX_TURNS,
    agentOpts.schema ?? null,
    prompt,
  ]);
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

/** Per-child fixed context overhead: the repo-instructions file at the child
 * cwd (CLAUDE.md preferred, AGENTS.md fallback) is loaded into every child's
 * system prompt. bytes/4 token heuristic; 0 when neither file exists. */
function estimateInstructionTokens(cwd: string): number {
  for (const f of ["CLAUDE.md", "AGENTS.md"]) {
    const p = join(cwd, f);
    if (existsSync(p)) {
      try {
        return Math.round(statSync(p).size / 4);
      } catch {
        return 0;
      }
    }
  }
  return 0;
}

/** Load a prior run's journal into a key → result map. Only `agent.end`
 * entries (completed, validated) are resumable; failed or retried-out agents
 * re-run live. Unreadable journal → error (a typo'd run id should fail loud,
 * not silently run everything fresh). */
function loadResumeCache(
  coordRoot: string,
  resumeFrom: string,
): Map<string, { kind: "json" | "text"; value: unknown }> {
  const path = join(coordRoot, ".harnery", "workflows", resumeFrom, "journal.jsonl");
  if (!existsSync(path)) {
    throw new Error(`--resume-from ${resumeFrom}: no journal at ${path}`);
  }
  const cache = new Map<string, { kind: "json" | "text"; value: unknown }>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as {
        event?: string;
        key?: string;
        result_kind?: "json" | "text";
        result?: unknown;
      };
      if (e.event === "agent.end" && e.key && e.result_kind !== undefined) {
        cache.set(e.key, { kind: e.result_kind, value: e.result });
      }
    } catch {
      /* skip malformed */
    }
  }
  return cache;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
