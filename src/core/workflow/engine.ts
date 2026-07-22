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
import type {
  ExternalMutationRequest,
  NormalizedPolicy,
  PolicyDecision,
  PolicyRequest,
} from "../policy/index.ts";
import {
  evaluatePolicy,
  normalizePolicy,
  PolicyDeniedError,
  policyDigest,
  summarizePolicyRequest,
} from "../policy/index.ts";
import { createWorkflowApproval } from "./approvals.ts";
import { type BillingProbe, probeBilling } from "./billing.ts";
import {
  buildWorkflowProof,
  createEvidenceRecord,
  digestResult,
  normalizeWorkflowMeta,
  writeWorkflowProof,
} from "./proof.ts";
import {
  acquireWorkflowResumeLease,
  assertWorkflowRunResumable,
  assertWorkflowScriptUnchanged,
  workflowScriptDigest,
  writeWorkflowRunManifest,
} from "./run-state.ts";
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
const DEFAULT_POLICY_ASK_TIMEOUT_MS = 60_000;
const MAX_POLICY_DECISIONS = 50;

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

export class WorkflowParkedError extends Error {
  readonly runId: string;
  readonly approvalId: string;
  readonly journalPath: string;

  constructor(message: string, runId: string, approvalId: string, journalPath: string) {
    super(message);
    this.name = "WorkflowParkedError";
    this.runId = runId;
    this.approvalId = approvalId;
    this.journalPath = journalPath;
  }
}

export async function runWorkflow(scriptPath: string, opts: EngineOpts): Promise<RunReport> {
  if (opts.resumeRunId && opts.resumeFrom) {
    throw new Error("resumeRunId and resumeFrom are mutually exclusive");
  }
  const resumeState = opts.resumeRunId
    ? assertWorkflowRunResumable(opts.coordRoot, opts.resumeRunId)
    : undefined;
  const absScript = isAbsolute(scriptPath) ? scriptPath : resolve(process.cwd(), scriptPath);
  if (resumeState) {
    if (resolve(resumeState.manifest.script.path) !== resolve(absScript)) {
      throw new Error(`workflow run ${opts.resumeRunId} belongs to a different script`);
    }
    assertWorkflowScriptUnchanged(resumeState.manifest);
  }
  const releaseResumeLease = opts.resumeRunId
    ? acquireWorkflowResumeLease(opts.coordRoot, opts.resumeRunId)
    : undefined;
  try {
    if (resumeState) {
      // Recheck under the exclusive lease. Another process may have completed
      // the run between the optimistic read and lease acquisition.
      assertWorkflowRunResumable(opts.coordRoot, resumeState.manifest.run_id);
    }
    return await executeWorkflow(scriptPath, absScript, opts, resumeState);
  } finally {
    releaseResumeLease?.();
  }
}

async function executeWorkflow(
  scriptPath: string,
  absScript: string,
  opts: EngineOpts,
  resumeState: ReturnType<typeof assertWorkflowRunResumable> | undefined,
): Promise<RunReport> {
  const mod = (await import(pathToFileURL(absScript).href)) as WorkflowModule;
  if (typeof mod.default !== "function") {
    throw new Error(`${scriptPath}: workflow script must \`export default async (ctx) => …\``);
  }
  const fallbackName = scriptPath.replace(/^.*\//, "").replace(/\.[cm]?js$/, "");
  const meta = normalizeWorkflowMeta(mod.meta, fallbackName);
  const name = meta.name;

  const runId =
    opts.resumeRunId ??
    `wf-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = join(opts.coordRoot, ".harnery", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const journalPath = join(runDir, "journal.jsonl");
  const proofPath = join(runDir, "proof.json");

  const frozen = resumeState?.manifest.execution;
  const maxAgents = frozen?.max_agents ?? opts.maxAgents ?? DEFAULT_MAX_AGENTS;
  const concurrency = frozen?.concurrency ?? opts.concurrency ?? DEFAULT_CONCURRENCY;
  assertPositiveWorkflowBound(maxAgents, "maxAgents");
  assertPositiveWorkflowBound(concurrency, "concurrency");
  const cwd = frozen?.cwd ?? opts.cwd ?? opts.coordRoot;
  const log = opts.onLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  const defaultHarness: HarnessName =
    frozen?.default_harness ?? opts.defaultHarness ?? "claude-code";
  const isolation = frozen?.isolation ?? opts.isolation ?? "shared";
  const networkAccess = frozen?.network_access ?? opts.networkAccess ?? "unknown";
  const policy =
    frozen?.policy ?? (opts.policy ? normalizePolicy(opts.policy, { baseDir: cwd }) : undefined);
  const approvalMode = frozen?.approval_mode ?? opts.approvalMode ?? "deny";
  const approvalAddressee = frozen?.approval_addressee ?? opts.approvalAddressee ?? "operator";
  const subscriptionOnly = frozen?.subscription_only ?? Boolean(opts.subscriptionOnly);
  const allowApiBilling = frozen?.allow_api_billing ?? Boolean(opts.allowApiBilling);
  const repoBefore = resumeState?.manifest.repository_before ?? snapshotRepo(cwd);
  const startedAt = resumeState?.manifest.started_at ?? new Date().toISOString();
  const t0 = resumeState ? Date.parse(startedAt) : Date.now();

  if (!resumeState) {
    writeWorkflowRunManifest({
      coordRoot: opts.coordRoot,
      manifest: {
        schema_version: 1,
        run_id: runId,
        name,
        started_at: startedAt,
        script: { path: absScript, sha256: workflowScriptDigest(absScript) },
        repository_before: repoBefore,
        execution: {
          cwd,
          default_harness: defaultHarness,
          max_agents: maxAgents,
          concurrency,
          subscription_only: subscriptionOnly,
          allow_api_billing: allowApiBilling,
          approval_mode: approvalMode,
          approval_addressee: approvalAddressee,
          isolation,
          network_access: networkAccess,
          policy: policy ? (policy as NormalizedPolicy) : undefined,
        },
      },
    });
  }

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
  const resumeSource = opts.resumeRunId ?? opts.resumeFrom;
  const resumeCache = resumeSource
    ? loadResumeCache(opts.coordRoot, resumeSource)
    : new Map<string, { kind: "json" | "text"; value: unknown }>();

  const history = opts.resumeRunId ? loadRunHistory(journalPath) : undefined;

  let agentsSpawned = history?.agentsSpawned ?? 0;
  let agentsCached = 0;
  let costUsd = history?.costUsd ?? 0;
  let reservedCostUsd = 0;
  let currentStage = "";
  let agentSeq = 0;
  let evidenceSeq = 0;
  let policySeq = 0;
  const billingProbed = new Map<HarnessName, BillingProbe>();
  const agentProofs = new Map<string, WorkflowAgentProof>();
  const evidenceRecords: WorkflowEvidenceRecord[] = [];
  const policyDecisions = new Map<string, PolicyDecision>(
    history?.policyDecisions.map((decision) => [decision.id, decision]),
  );
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

  // Policy checks that affect the shared cost reservation ledger serialize.
  // Spawns still run concurrently after authorization; only the last-moment
  // check-and-reserve section is exclusive.
  let policyGate = Promise.resolve();
  const withDispatchPolicyGate = async <T>(work: () => Promise<T>): Promise<T> => {
    const previous = policyGate;
    let open!: () => void;
    policyGate = new Promise<void>((resolveGate) => {
      open = resolveGate;
    });
    await previous;
    try {
      return await work();
    } finally {
      open();
    }
  };

  const authorizePolicyRequest = async (rawRequest: PolicyRequest): Promise<PolicyDecision> => {
    if (!policy) {
      throw new Error("external mutation authorization requires a host policy");
    }
    if (policyDecisions.size >= MAX_POLICY_DECISIONS && !policyDecisions.has(`p${policySeq + 1}`)) {
      throw new Error(
        `workflow policy decision cap reached (${MAX_POLICY_DECISIONS}); split the workflow or reduce protected actions`,
      );
    }
    const request = summarizePolicyRequest(rawRequest);
    const evaluation = evaluatePolicy(policy, request);
    const id = `p${++policySeq}`;
    const checkedAt = new Date().toISOString();
    journal("policy.check", {
      id,
      policy: policy.name,
      policy_sha256: policyDigest(policy),
      request,
      verdict: evaluation.verdict,
      rules: evaluation.rules,
    });

    let verdict: "allow" | "deny" = evaluation.verdict === "allow" ? "allow" : "deny";
    let resolvedBy: PolicyDecision["resolved_by"] = "policy";
    let reason = evaluation.reason;
    if (evaluation.verdict === "ask") {
      resolvedBy = "fail_closed";
      let immediateResolution = false;
      if (opts.resolvePolicyAsk) {
        try {
          const resolution = await withTimeout(
            Promise.resolve(opts.resolvePolicyAsk(request, evaluation)),
            opts.policyAskTimeoutMs ?? DEFAULT_POLICY_ASK_TIMEOUT_MS,
          );
          if (!resolution || (resolution.verdict !== "allow" && resolution.verdict !== "deny")) {
            reason = `${evaluation.reason}; host returned an invalid approval resolution`;
          } else {
            verdict = resolution.verdict;
            resolvedBy = "host";
            reason = boundedPolicyReason(resolution.reason ?? evaluation.reason);
            immediateResolution = true;
          }
        } catch (error) {
          reason = `${evaluation.reason}; approval failed closed: ${(error as Error).message}`;
        }
      } else {
        reason = `${evaluation.reason}; no host approval resolver is configured`;
      }

      if (!immediateResolution && approvalMode === "park") {
        const stored = createWorkflowApproval({
          coordRoot: opts.coordRoot,
          runId,
          decisionId: id,
          addressedTo: approvalAddressee,
          policy: { name: policy.name, sha256: policyDigest(policy) },
          request,
          evaluation,
        });
        if (stored.approval.status === "pending") {
          if (stored.created) {
            journal("approval.requested", {
              approval_id: stored.approval.request.id,
              decision_id: id,
              addressed_to: stored.approval.request.addressed_to,
              request_sha256: stored.approval.request.request_sha256,
            });
          }
          journal("run.parked", {
            approval_id: stored.approval.request.id,
            decision_id: id,
            phase: request.phase,
            action: request.action,
          });
          throw new WorkflowParkedError(
            `workflow parked for approval ${stored.approval.request.id}: ${evaluation.reason}`,
            runId,
            stored.approval.request.id,
            journalPath,
          );
        }
        verdict = stored.approval.decision!.verdict;
        resolvedBy = "approval";
        reason = boundedPolicyReason(stored.approval.decision!.reason ?? evaluation.reason);
        journal("approval.consumed", {
          approval_id: stored.approval.request.id,
          decision_id: id,
          verdict,
          actor: stored.approval.decision!.actor,
          decided_at: stored.approval.decision!.decided_at,
        });
      }
    }

    const decision: PolicyDecision = {
      id,
      checked_at: checkedAt,
      policy: policy.name,
      phase: request.phase,
      initial_verdict: evaluation.verdict,
      verdict,
      resolved_by: resolvedBy,
      reason: boundedPolicyReason(reason),
      rule_codes: evaluation.rules.map((rule) => rule.code),
      request,
    };
    policyDecisions.set(decision.id, decision);
    journal("policy.resolve", { ...decision });
    if (decision.verdict === "deny") {
      throw new PolicyDeniedError(
        `policy ${JSON.stringify(policy.name)} denied ${request.phase} ${JSON.stringify(request.action)}: ${decision.reason}`,
        decision.id,
      );
    }
    return decision;
  };

  const agent = async (prompt: string, agentOpts: AgentOpts = {}): Promise<unknown> => {
    let reservedForDispatch = 0;
    let spawnCountClaimed = false;
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
      // Exact-run replay skips dispatch authorization because no dispatch
      // occurs, but it must still reserve the original policy slot so a later
      // durable ASK resolves against the same pN identity.
      if (policy && opts.resumeRunId) policySeq++;
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
        `[${name}] ${currentStage || "(no stage)"} → ${id} ${label} (cached from ${resumeSource})`,
      );
      return cached.value;
    }

    if (policy) {
      const estimateRequest = summarizePolicyRequest({
        phase: "dispatch",
        action: "spawn agent",
        path: cwd,
        harness,
        model: agentOpts.model,
        effort: agentOpts.effort,
        max_attempts: maxAttempts,
        max_turns: agentOpts.maxTurns ?? DEFAULT_MAX_TURNS,
        timeout_ms: agentOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        prompt_bytes: Buffer.byteLength(prompt),
        isolation,
        network_access: networkAccess,
        current_cost_usd: round4(costUsd + reservedCostUsd),
        projected_cost_usd: null,
      });
      let projectedCost: number | null = null;
      if (policy.max_cost_usd !== undefined && opts.estimateDispatchCost) {
        try {
          const candidate = await opts.estimateDispatchCost(estimateRequest);
          if (candidate !== null && (!Number.isFinite(candidate) || candidate < 0)) {
            throw new Error("cost estimator returned a non-finite or negative value");
          }
          projectedCost = candidate;
        } catch (error) {
          journal("policy.cost_estimate_failed", {
            harness,
            model: agentOpts.model ?? null,
            error: boundedPolicyReason((error as Error).message),
          });
        }
      }
      try {
        await withDispatchPolicyGate(async () => {
          assertAgentCapacity(agentsSpawned, maxAgents);
          const dispatchRequest = {
            ...estimateRequest,
            current_cost_usd: round4(costUsd + reservedCostUsd),
            projected_cost_usd: projectedCost,
          };
          await authorizePolicyRequest(dispatchRequest);
          if (policy.max_cost_usd !== undefined) {
            reservedForDispatch =
              projectedCost ?? Math.max(0, policy.max_cost_usd - dispatchRequest.current_cost_usd);
            reservedCostUsd += reservedForDispatch;
          }
          agentsSpawned++;
          spawnCountClaimed = true;
        });
      } catch (error) {
        agentProof.error = (error as Error).message;
        throw error;
      }
    } else {
      try {
        assertAgentCapacity(agentsSpawned, maxAgents);
      } catch (error) {
        agentProof.error = (error as Error).message;
        throw error;
      }
    }

    // Billing safeguard: on a harness's FIRST spawn this run, classify which
    // auth its children will use and refuse the silent-override state (an
    // exported API key shadowing a stored subscription login) unless the
    // caller explicitly opted into API billing. Cached agents never reach
    // this — no spawn, no billing.
    try {
      if (!billingProbed.has(harness)) {
        const probe = (opts.probeBilling ?? probeBilling)(harness);
        billingProbed.set(harness, probe);
        journal("billing.probe", {
          harness,
          mode: subscriptionOnly ? "subscription" : probe.mode,
          api_key_source: probe.apiKeySource,
          login: probe.login,
          subscription_only: subscriptionOnly,
        });
        if (subscriptionOnly) {
          if (probe.login === "absent") {
            throw new Error(
              `subscription-only: no stored login detected for ${harness}; ` +
                `log the harness CLI in (or drop --subscription-only for a key-only host)`,
            );
          }
          log(`[billing] ${harness}: subscription-only (API-key vars scrubbed from child env)`);
        } else if (probe.mode === "api-key-override" && !allowApiBilling) {
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
    } catch (error) {
      reservedCostUsd = Math.max(0, reservedCostUsd - reservedForDispatch);
      reservedForDispatch = 0;
      if (spawnCountClaimed) {
        agentsSpawned--;
        spawnCountClaimed = false;
      }
      agentProof.error = (error as Error).message;
      throw error;
    }

    if (!spawnCountClaimed) agentsSpawned++;

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
          subscriptionOnly,
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
            total_cost_usd: agentCostUsd,
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
            total_cost_usd: agentCostUsd,
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
      reservedCostUsd = Math.max(0, reservedCostUsd - reservedForDispatch);
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

  const authorize = async (input: ExternalMutationRequest): Promise<PolicyDecision> => {
    const network =
      input.network === true || input.service !== undefined || input.target !== undefined
        ? "enabled"
        : "disabled";
    return authorizePolicyRequest({
      phase: "external_mutation",
      action: input.action,
      path: input.path ? resolve(cwd, input.path) : undefined,
      isolation,
      network_access: network,
      service: input.service,
      target: input.target,
      current_cost_usd: round4(costUsd),
    });
  };

  const ctx: WorkflowContext = { agent, parallel, stage, log, evidence, authorize };
  try {
    if (resumeState) {
      journal("run.resume", {
        approval_id: resumeState.approvalId,
        script: absScript,
        resumed_at: new Date().toISOString(),
      });
    } else {
      journal("run.start", {
        name,
        script: absScript,
        objective: meta.objective ?? null,
        acceptance: meta.acceptance,
        max_agents: maxAgents,
        concurrency,
        policy: policy ? { name: policy.name, sha256: policyDigest(policy) } : null,
        isolation,
        network_access: networkAccess,
      });
    }
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
        policy: policy
          ? {
              config: policy,
              decisions: Array.from(policyDecisions.values()),
              isolation,
              networkAccess,
            }
          : undefined,
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
        mode: subscriptionOnly ? "subscription" : p.mode,
      })),
      policy: proof.policy?.summary,
    };
    return report;
  } catch (err) {
    if (err instanceof WorkflowParkedError || err instanceof WorkflowRunError) throw err;
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
        policy: policy
          ? {
              config: policy,
              decisions: Array.from(policyDecisions.values()),
              isolation,
              networkAccess,
            }
          : undefined,
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

function loadRunHistory(path: string): {
  agentsSpawned: number;
  costUsd: number;
  policyDecisions: PolicyDecision[];
} {
  const agentIds = new Set<string>();
  const agentCosts = new Map<string, number>();
  const decisions = new Map<string, PolicyDecision>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as {
      event?: string;
      id?: string;
      cost_usd?: number;
      total_cost_usd?: number;
      verdict?: unknown;
      resolved_by?: unknown;
      request?: unknown;
    };
    if (event.event === "agent.start" && typeof event.id === "string") {
      agentIds.add(event.id);
    }
    if (event.event === "agent.end" && typeof event.id === "string") {
      const cost = event.total_cost_usd ?? event.cost_usd;
      if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        agentCosts.set(event.id, cost);
      }
    }
    if (
      event.event === "policy.resolve" &&
      typeof event.id === "string" &&
      (event.verdict === "allow" || event.verdict === "deny") &&
      typeof event.resolved_by === "string" &&
      event.request &&
      typeof event.request === "object"
    ) {
      decisions.set(event.id, event as PolicyDecision);
    }
  }
  return {
    agentsSpawned: agentIds.size,
    costUsd: round4(Array.from(agentCosts.values()).reduce((sum, value) => sum + value, 0)),
    policyDecisions: Array.from(decisions.values()),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function assertAgentCapacity(agentsSpawned: number, maxAgents: number): void {
  if (agentsSpawned >= maxAgents) {
    throw new Error(
      `workflow agent cap reached (${maxAgents}); raise --max-agents deliberately if the fan-out is intended`,
    );
  }
}

function assertPositiveWorkflowBound(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function boundedPolicyReason(value: string): string {
  const normalized = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 2_000 ? `${normalized.slice(0, 1_999)}…` : normalized;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("policyAskTimeoutMs must be a positive finite number");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`approval timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
