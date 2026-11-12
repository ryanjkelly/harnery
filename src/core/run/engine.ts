/**
 * Workflow engine: loads a workflow script (plain JS, `export default
 * async (ctx) => …`), injects the ctx API, enforces the caps, transcripts every
 * step to `.harnery/workflows/<run-id>/transcript.jsonl`, and returns a RunReport.
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
 *   - **Transcripted**: every stage/agent start+end lands in the run transcript with
 *     cost, duration, and child session id (the resume + web-UI substrate).
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { builtinAdapterProfile } from "../adapters/profiles.ts";
import { workflowWorkerFullAccessConfig } from "../config.ts";
import { snapshotRepo } from "../context/index.ts";
import { decideHelperLimit, helperLadders } from "../helper-limit.ts";
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
import { assertWorkflowRunId, createWorkflowApproval } from "./approvals.ts";
import { type BillingProbe, probeBilling } from "./billing.ts";
import { evidencePreflightError } from "./evidence-preflight.ts";
import { endWorkflowChildSessionV3, startWorkflowChildSessionV3 } from "./live-session-v3.ts";
import {
  buildWorkflowProof,
  createEvidenceRecord,
  digestResult,
  normalizeWorkflowMeta,
  writeWorkflowProof,
} from "./proof.ts";
import { acquireWorkflowResumeLease } from "./resume-lock.ts";
import {
  assertWorkflowRunResumable,
  assertWorkflowScriptUnchanged,
  WORKFLOW_RUN_MANIFEST_SCHEMA_VERSION,
  workflowScriptDigest,
  writeWorkflowRunManifest,
} from "./run-state.ts";
import { normalizeWorkflowSpecialists, resolveSpecialistAssignment } from "./specialists.ts";
import { appendWorkflowTranscriptEvent } from "./transcript.ts";
import type {
  AdapterName,
  AgentOpts,
  BlockedInput,
  EngineOpts,
  ParentAccessEvidence,
  RunReport,
  SpawnFilesystemPolicy,
  SpawnResult,
  StageSchema,
  WorkflowAgentProof,
  WorkflowContext,
  WorkflowEvidenceRecord,
  WorkflowModule,
  WorkflowProof,
  WorkflowSandboxProjectionEvidence,
} from "./types.ts";
import { parseStageOutput, validateAgainstSchema } from "./validate.ts";
import {
  decideWorkerAccess,
  detectParentAccess,
  parseWorkerFullAccessPolicy,
} from "./worker-access.ts";

/** Proof record of the filesystem projection a run applied (ADR 0039).
 * Absent when no policy was in force, which reads as "no projection applied"
 * rather than "an empty one". */
function sandboxProjectionEvidence(
  policy: SpawnFilesystemPolicy | undefined,
): WorkflowSandboxProjectionEvidence | undefined {
  if (!policy) return undefined;
  return {
    mode: policy.mode,
    writable_roots: [...(policy.writableRoots ?? [])],
  };
}

const DEFAULT_MAX_AGENTS = 50;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Deterministic coordination identity for a spawned child.
 *
 * Stable per (run, agent) so a re-register refreshes one heartbeat instead of
 * accumulating duplicates, and so an orphan left by a killed engine is
 * greppable straight back to the run that owned it.
 */
function childInstanceId(runId: string, agentId: string): string {
  return `${runId}-${agentId}`;
}
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
  readonly transcriptPath: string;

  constructor(message: string, runId: string, approvalId: string, transcriptPath: string) {
    super(message);
    this.name = "WorkflowParkedError";
    this.runId = runId;
    this.approvalId = approvalId;
    this.transcriptPath = transcriptPath;
  }
}

/** Thrown by ctx.blocked(). Carries the run out of the script and into the
 * failure path, where its presence — not its message — is what stamps the proof
 * with class "decision". A script cannot fake this by throwing an ordinary
 * Error with a suggestive message, which is the point: the class has to mean
 * "the script deliberately declared this", not "the text looked like it". */
export class WorkflowBlockedError extends Error {
  readonly reason: string;
  readonly decisionId?: string;

  constructor(reason: string, decisionId?: string) {
    super(
      decisionId
        ? `blocked on decision ${decisionId}: ${reason}`
        : `blocked pending a human decision: ${reason}`,
    );
    this.name = "WorkflowBlockedError";
    this.reason = reason;
    this.decisionId = decisionId;
  }
}

export async function runWorkflow(scriptPath: string, opts: EngineOpts): Promise<RunReport> {
  if (opts.runId && opts.resumeRunId) {
    throw new Error("runId and resumeRunId are mutually exclusive");
  }
  if (opts.runId) assertWorkflowRunId(opts.runId);
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

/** Throws when the script names an evidence kind the proof layer will refuse.
 * Silent when the file cannot be read: the import a moment later will produce a
 * better error than a guess from here would. */
function assertEvidenceKindsAreUsable(scriptPath: string, absScript: string): void {
  let source: string;
  try {
    source = readFileSync(absScript, "utf8");
  } catch {
    return;
  }
  const message = evidencePreflightError(source, scriptPath);
  if (message) throw new Error(message);
}

async function executeWorkflow(
  scriptPath: string,
  absScript: string,
  opts: EngineOpts,
  resumeState: ReturnType<typeof assertWorkflowRunResumable> | undefined,
): Promise<RunReport> {
  const frozen = resumeState?.manifest.execution;
  // Before anything is spawned: an evidence kind the proof will reject is fatal
  // at the END of a workflow, which is the most expensive place to learn it.
  // Reading the file is the cheapest moment.
  assertEvidenceKindsAreUsable(scriptPath, absScript);
  const mod = (await import(pathToFileURL(absScript).href)) as WorkflowModule;
  if (typeof mod.default !== "function") {
    throw new Error(`${scriptPath}: workflow script must \`export default async (ctx) => …\``);
  }
  const fallbackName = scriptPath.replace(/^.*\//, "").replace(/\.[cm]?js$/, "");
  const workflow = mod.default;
  const meta = normalizeWorkflowMeta(mod.meta, fallbackName);

  const runId =
    opts.resumeRunId ??
    opts.runId ??
    `wf-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = join(opts.coordRoot, ".harnery", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const transcriptPath = join(runDir, "transcript.jsonl");
  const proofPath = join(runDir, "proof.json");

  const maxAgents = frozen?.max_agents ?? opts.maxAgents ?? DEFAULT_MAX_AGENTS;
  const concurrency = frozen?.concurrency ?? opts.concurrency ?? DEFAULT_CONCURRENCY;
  assertPositiveWorkflowBound(maxAgents, "maxAgents");
  assertPositiveWorkflowBound(concurrency, "concurrency");
  const cwd = frozen?.cwd ?? opts.cwd ?? opts.coordRoot;
  const log = opts.onLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  const defaultAdapter: AdapterName =
    frozen?.default_adapter ?? opts.defaultAdapter ?? "claude-code";
  const specialists =
    frozen?.specialists ?? (resumeState ? {} : normalizeWorkflowSpecialists(opts.specialists));
  const networkAccess = frozen?.network_access ?? opts.networkAccess ?? "unknown";
  const policy =
    frozen?.policy ?? (opts.policy ? normalizePolicy(opts.policy, { baseDir: cwd }) : undefined);
  const approvalMode = frozen?.approval_mode ?? opts.approvalMode ?? "deny";
  const approvalAddressee = frozen?.approval_addressee ?? opts.approvalAddressee ?? "operator";
  const subscriptionOnly = frozen?.subscription_only ?? Boolean(opts.subscriptionOnly);
  const allowApiBilling = frozen?.allow_api_billing ?? Boolean(opts.allowApiBilling);
  const startedAt = resumeState?.manifest.started_at ?? new Date().toISOString();
  const t0 = resumeState ? Date.parse(startedAt) : Date.now();
  const scriptSha256 = resumeState?.manifest.script.sha256 ?? workflowScriptDigest(absScript);
  const executionCwd = cwd;
  // A filesystem policy is projected into each adapter's own sandbox
  // (ADR 0039). Explicit writable roots need a root that something has already
  // validated, and the run engine has no isolated workspace to provide one, so
  // a policy that names them is refused before any child launches rather than
  // silently widening a child's write access.
  const filesystemPolicy: SpawnFilesystemPolicy | undefined = opts.filesystemPolicy;
  if (filesystemPolicy?.writableRoots?.length) {
    throw new Error(
      "a filesystem policy with writable roots is not supported: runs execute in the shared checkout, which has no validated root to contain them",
    );
  }
  // Worker full access (ADR 0192) is decided per launch. The host policy is
  // read once per run; the parent probe runs at most once, and only when a
  // launch has already cleared every cheaper condition.
  const workerFullAccess = parseWorkerFullAccessPolicy(
    workflowWorkerFullAccessConfig(opts.coordRoot),
  );
  let parentAccess: ParentAccessEvidence | undefined;
  const executionRepoBefore = resumeState?.manifest.repository_before ?? snapshotRepo(executionCwd);
  if (!resumeState) {
    writeWorkflowRunManifest({
      coordRoot: opts.coordRoot,
      manifest: {
        schema_version: WORKFLOW_RUN_MANIFEST_SCHEMA_VERSION,
        run_id: runId,
        name: meta.name,
        started_at: startedAt,
        script: { path: absScript, sha256: scriptSha256 },
        repository_before: executionRepoBefore,
        execution: {
          cwd: executionCwd,
          default_adapter: defaultAdapter,
          max_agents: maxAgents,
          concurrency,
          subscription_only: subscriptionOnly,
          allow_api_billing: allowApiBilling,
          approval_mode: approvalMode,
          approval_addressee: approvalAddressee,
          network_access: networkAccess,
          policy: policy ? (policy as NormalizedPolicy) : undefined,
          specialists,
        },
      },
    });
  }

  const name = meta.name;

  // Per-child fixed context overhead: children spawn in `cwd` and load its
  // repo-instructions file into their system prompt, cache-writing it once
  // per child. A fan-out multiplies this, so surface it BEFORE the burn.
  const contextTokensPerChildEstimate = estimateInstructionTokens(executionCwd);
  if (contextTokensPerChildEstimate > 0) {
    log(
      `[context] each child cache-writes ~${Math.round(contextTokensPerChildEstimate / 1000)}K tokens of repo ` +
        `instructions from ${executionCwd}; a fan-out multiplies this per agent`,
    );
  }

  // Resume: transcripted results of a prior run, keyed by agent-call identity.
  const resumeSource = opts.resumeRunId ?? opts.resumeFrom;
  const resumeCache = resumeSource
    ? loadResumeCache(opts.coordRoot, resumeSource)
    : new Map<string, { kind: "json" | "text"; value: unknown }>();

  const history = opts.resumeRunId ? loadRunHistory(transcriptPath) : undefined;

  let agentsSpawned = history?.agentsSpawned ?? 0;
  let agentsCached = 0;
  let costUsd = history?.costUsd ?? 0;
  let reservedCostUsd = 0;
  let currentStage = "";
  let agentSeq = 0;
  let evidenceSeq = 0;
  let policySeq = 0;
  const billingProbed = new Map<AdapterName, BillingProbe>();
  const agentProofs = new Map<string, WorkflowAgentProof>();
  let terminalRecordingError: Error | undefined;
  const evidenceRecords: WorkflowEvidenceRecord[] = [];
  const policyDecisions = new Map<string, PolicyDecision>(
    history?.policyDecisions.map((decision) => [decision.id, decision]),
  );
  const acceptanceIds = new Set(meta.acceptance.map((criterion) => criterion.id));

  const transcript = (event: string, data: Record<string, unknown>): void => {
    appendWorkflowTranscriptEvent(opts.coordRoot, runId, event, { stage: currentStage, ...data });
  };
  const transcriptAgentEnd = (
    data: Record<string, unknown>,
    resultKind: "text" | "json",
    result: unknown,
  ): void => {
    // The writer shrinks an oversized record itself and names what it dropped,
    // so no per-call fallback is needed here. A digest rides along regardless so
    // a shrunk record can still be tied back to the exact result.
    transcript("agent.end", {
      ...data,
      result_kind: resultKind,
      result_digest: digestResult(result, resultKind),
      result,
    });
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
    transcript("policy.check", {
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
            transcript("approval.requested", {
              approval_id: stored.approval.request.id,
              decision_id: id,
              addressed_to: stored.approval.request.addressed_to,
              request_sha256: stored.approval.request.request_sha256,
            });
          }
          transcript("run.parked", {
            approval_id: stored.approval.request.id,
            decision_id: id,
            phase: request.phase,
            action: request.action,
          });
          throw new WorkflowParkedError(
            `workflow parked for approval ${stored.approval.request.id}: ${evaluation.reason}`,
            runId,
            stored.approval.request.id,
            transcriptPath,
          );
        }
        verdict = stored.approval.decision!.verdict;
        resolvedBy = "approval";
        reason = boundedPolicyReason(stored.approval.decision!.reason ?? evaluation.reason);
        transcript("approval.consumed", {
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
    transcript("policy.resolve", { ...decision });
    if (decision.verdict === "deny") {
      throw new PolicyDeniedError(
        `policy ${JSON.stringify(policy.name)} denied ${request.phase} ${JSON.stringify(request.action)}: ${decision.reason}`,
        decision.id,
      );
    }
    return decision;
  };

  const agent = async (prompt: string, requestedOpts: AgentOpts = {}): Promise<unknown> => {
    const assignment = resolveSpecialistAssignment(specialists, prompt, requestedOpts);
    const adapter = assignment.opts.adapter ?? defaultAdapter;
    // The helper limit is applied here, once, so the proof record, resume key,
    // cost estimate, access decision and spawn all read the values the worker
    // really runs with. Applying it later would let a worker qualify for full
    // access as a stronger model than the one it is sent on.
    const askedModel = assignment.opts.model;
    const askedEffort = assignment.opts.effort;
    const helperLimit = applyHelperLimit(assignment.opts, adapter, opts.helperLimit);
    const agentOpts = helperLimit.opts;
    const assignmentPrompt = assignment.prompt;
    const dispatchPrompt = agentOpts.schema
      ? withSchemaContract(assignmentPrompt, agentOpts.schema)
      : assignmentPrompt;
    let reservedForDispatch = 0;
    let spawnCountClaimed = false;
    const spawner = opts.spawners[adapter];
    if (!spawner) {
      throw new Error(
        `no spawner registered for adapter "${adapter}" (registered: ${Object.keys(opts.spawners).join(", ") || "none"})`,
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
      specialist: agentOpts.specialist,
      adapter,
      model: agentOpts.model,
      status: "failed",
      attempts: 0,
      duration_ms: 0,
    };
    agentProofs.set(id, agentProof);
    if (helperLimit.lowered) {
      transcript("helper_limit.lowered", {
        id,
        adapter,
        asked_model: askedModel ?? null,
        asked_effort: askedEffort ?? null,
        sent_model: agentOpts.model ?? null,
        sent_effort: agentOpts.effort ?? null,
      });
    }

    // Call identity for resume: same stage + adapter + model + effort + turns + schema
    // + ORIGINAL prompt → same key. Retry-mutated prompts never enter the key.
    const key = agentCallKey(currentStage, adapter, agentOpts, assignmentPrompt);
    const cached = resumeCache.get(key);
    if (cached) {
      // Exact-run replay skips dispatch authorization because no dispatch
      // occurs, but it must still reserve the original policy slot so a later
      // durable ASK resolves against the same pN identity.
      if (policy && opts.resumeRunId) policySeq++;
      agentsCached++;
      agentProof.status = "cached";
      agentProof.result = digestResult(cached.value, cached.kind);
      transcript("agent.cached", {
        id,
        label,
        key,
        adapter,
        specialist: agentOpts.specialist ?? null,
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
        path: executionCwd,
        adapter,
        model: agentOpts.model,
        effort: agentOpts.effort,
        max_attempts: maxAttempts,
        max_turns: agentOpts.maxTurns ?? DEFAULT_MAX_TURNS,
        timeout_ms: agentOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        prompt_bytes: Buffer.byteLength(dispatchPrompt),
        isolation: "shared",
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
          transcript("policy.cost_estimate_failed", {
            adapter,
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

    // Billing safeguard: on a adapter's FIRST spawn this run, classify which
    // auth its children will use and refuse the silent-override state (an
    // exported API key shadowing a stored subscription login) unless the
    // caller explicitly opted into API billing. Cached agents never reach
    // this — no spawn, no billing.
    try {
      if (!billingProbed.has(adapter)) {
        const probe = (opts.probeBilling ?? probeBilling)(adapter);
        billingProbed.set(adapter, probe);
        transcript("billing.probe", {
          adapter,
          mode: subscriptionOnly ? "subscription" : probe.mode,
          api_key_source: probe.apiKeySource,
          login: probe.login,
          subscription_only: subscriptionOnly,
        });
        if (subscriptionOnly) {
          if (probe.login === "absent") {
            throw new Error(
              `subscription-only: no stored login detected for ${adapter}; ` +
                `log the adapter CLI in (or drop --subscription-only for a key-only host)`,
            );
          }
          log(`[billing] ${adapter}: subscription-only (API-key vars scrubbed from child env)`);
        } else if (probe.mode === "api-key-override" && !allowApiBilling) {
          throw new Error(
            `${probe.apiKeySource} is set AND a stored ${adapter} login exists — the key silently ` +
              `overrides your subscription auth, so children would bill per-token API rates. ` +
              `Either unset ${probe.apiKeySource}, run with --subscription-only to scrub it from ` +
              `child envs, or pass --allow-api-billing if API billing is intended`,
          );
        } else if (probe.mode === "api-key") {
          log(
            `[billing] ${adapter}: API-key billing (${probe.apiKeySource}; no stored login detected) — ` +
              `children bill per-token rates`,
          );
        } else if (probe.mode === "api-key-override") {
          log(
            `[billing] ${adapter}: API-key billing (--allow-api-billing; key overrides stored login)`,
          );
        } else {
          log(`[billing] ${adapter}: subscription login`);
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

    const access = decideWorkerAccess({
      adapter,
      model: agentOpts.model,
      effort: agentOpts.effort,
      policy: workerFullAccess,
      filesystemPolicy,
      parent: () => {
        if (!parentAccess) {
          parentAccess = (opts.detectParentAccess ?? detectParentAccess)();
          transcript("worker_access.parent", { ...parentAccess });
        }
        return parentAccess;
      },
    });
    agentProof.access = access;
    if (opts.recordHelperUsage) {
      try {
        opts.recordHelperUsage({
          ts: new Date().toISOString(),
          tool: adapter,
          kind: "run-worker",
          session_id: runId,
          agent_id: childInstanceId(runId, id),
          ...(agentOpts.specialist ? { agent_type: agentOpts.specialist } : {}),
          ...(askedModel !== undefined ? { asked_model: askedModel } : {}),
          ...(askedEffort !== undefined ? { asked_effort: askedEffort } : {}),
          ...(agentOpts.model !== undefined ? { sent_model: agentOpts.model } : {}),
          ...(agentOpts.effort !== undefined ? { sent_effort: agentOpts.effort } : {}),
          lowered: helperLimit.lowered,
        });
      } catch {
        // A usage record is best effort and must never fail the run.
      }
    }

    let recordAgentEnd: (() => void) | undefined;
    const finalizeChild = (): void => {
      try {
        // Record the canonical terminal first. agent.end is the resume-cache
        // boundary, so a child whose end was not recorded never reports success.
        endWorkflowChildSessionV3({
          coordRoot: opts.coordRoot,
          instanceId: childInstanceId(runId, id),
          runId,
          agentId: id,
          adapter,
          cleanExit: agentProof.status === "succeeded",
        });
        recordAgentEnd?.();
      } catch (error) {
        const reason = `V3 terminal recording failed: ${(error as Error).message}`;
        const failure = new Error(agentProof.error ? `${agentProof.error}; ${reason}` : reason, {
          cause: error,
        });
        terminalRecordingError ??= failure;
        agentProof.status = "failed";
        agentProof.error = failure.message;
        transcript("agent.failed", { id, key, error: failure.message });
        log(`[${name}] ${failure.message}`);
        throw failure;
      }
    };
    await acquire();
    try {
      transcript("agent.start", {
        id,
        label,
        key,
        adapter,
        specialist: agentOpts.specialist ?? null,
        model: agentOpts.model ?? null,
        effort: agentOpts.effort ?? null,
        access,
      });
      if (access.mode === "full-access") {
        log(`[access] ${id} ${adapter}: full access (${access.detail})`);
      }
      log(`[${name}] ${currentStage || "(no stage)"} → ${id} [${adapter}] ${label}`);

      // Headless children do not reliably fire adapter hooks. The engine owns
      // their canonical V3 start so every dispatched child has an auditable
      // generation before it begins work.
      startWorkflowChildSessionV3({
        coordRoot: opts.coordRoot,
        instanceId: childInstanceId(runId, id),
        runId,
        agentId: id,
        adapter,
        label,
        model: agentOpts.model,
      });

      let attemptPrompt = dispatchPrompt;
      let last: SpawnResult | null = null;
      let agentCostUsd = 0;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        last = await spawner({
          prompt: attemptPrompt,
          model: agentOpts.model,
          effort: agentOpts.effort,
          timeoutMs: agentOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxTurns: agentOpts.maxTurns ?? DEFAULT_MAX_TURNS,
          cwd: executionCwd,
          runId,
          agentId: id,
          subscriptionOnly,
          ...(agentOpts.mcp ? { mcp: agentOpts.mcp } : {}),
          // A full-access launch has no sandbox to project a policy into.
          ...(access.mode === "full-access"
            ? { access: "full-access" as const }
            : { filesystemPolicy }),
        });
        agentProof.attempts = attempt;
        agentProof.duration_ms += last.durationMs;
        agentCostUsd += last.costUsd ?? 0;
        costUsd += last.costUsd ?? 0;

        if (!last.ok) {
          transcript("agent.attempt_failed", { id, attempt, error: last.error });
          // ADR 0046: an environment failure (the binary was absent) cannot be
          // helped by retrying an unchanged environment, so stop the in-agent
          // retry too — not just the outer attempt/replan budget. An upstream
          // refusal keeps retrying here: the vendor may recover mid-loop.
          if (last.class === "environment") break;
          continue; // spawn-level failure: retry with the original prompt
        }
        if (!agentOpts.schema) {
          agentProof.status = "succeeded";
          agentProof.cost_usd =
            agentCostUsd > 0 || last.costUsd !== undefined ? agentCostUsd : undefined;
          agentProof.session_id = last.sessionId;
          agentProof.result = digestResult(last.text, "text");
          const completed = last;
          recordAgentEnd = () =>
            transcriptAgentEnd(
              {
                id,
                key,
                attempts: attempt,
                cost_usd: completed.costUsd,
                total_cost_usd: agentCostUsd,
                duration_ms: completed.durationMs,
                session_id: completed.sessionId,
              },
              "text",
              completed.text,
            );
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
          const completed = last;
          recordAgentEnd = () =>
            transcriptAgentEnd(
              {
                id,
                key,
                attempts: attempt,
                cost_usd: completed.costUsd,
                total_cost_usd: agentCostUsd,
                duration_ms: completed.durationMs,
                session_id: completed.sessionId,
              },
              "json",
              parsed.value,
            );
          return parsed.value;
        }

        transcript("agent.schema_retry", { id, attempt, problems });
        // Keep the original cache identity while making the actual output
        // contract explicit. A full bounded copy of the rejected value lets the
        // child repair omissions instead of reconstructing an unseen object.
        attemptPrompt =
          `${dispatchPrompt}\n\nYour previous reply failed validation. ` +
          `Return a complete replacement value, not a patch.\n\n` +
          `Previous reply (JSON string): ${JSON.stringify(boundedSchemaReply(last.text))}\n\n` +
          `Validation problems:\n` +
          `${problems.map((p) => `  - ${p}`).join("\n")}\n` +
          `Reply with ONLY the corrected JSON value. No prose, no code fences.`;
      }

      const reason = last?.ok
        ? `schema validation failed after ${maxAttempts} attempt(s)`
        : (last?.error ?? "spawn failed");
      agentProof.cost_usd =
        agentCostUsd > 0 || last?.costUsd !== undefined ? agentCostUsd : undefined;
      agentProof.session_id = last?.sessionId;
      agentProof.error = reason;
      // Carry the spawn class (environment/upstream) onto the proof only when the
      // final outcome was a spawn failure. A schema failure after a spawn that
      // reached the model is a work failure — left unclassed (charged). An
      // earlier attempt that transiently failed and then succeeded returned
      // above, so this only fires when the agent genuinely failed.
      if (last && !last.ok && last.class) agentProof.class = last.class;
      transcript("agent.failed", { id, error: reason });
      throw new Error(`agent ${proofLabel}: ${reason}`);
    } catch (error) {
      agentProof.error ??= (error as Error).message;
      throw error;
    } finally {
      reservedCostUsd = Math.max(0, reservedCostUsd - reservedForDispatch);
      try {
        finalizeChild();
      } finally {
        release();
      }
    }
  };

  const parallel = async <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> => {
    // Fire everything; the shared slot pool inside agent() bounds real
    // concurrency. A rejected thunk lands as null so one bad item can't kill
    // the batch — the script filters and routes.
    return Promise.all(
      thunks.map((t) =>
        t().catch((err: unknown) => {
          transcript("parallel.item_failed", { error: (err as Error).message });
          return null;
        }),
      ),
    );
  };

  const stage = (title: string): void => {
    currentStage = title;
    transcript("stage.start", { title });
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
    transcript("evidence.recorded", { ...record });
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
      path: input.path ? resolve(executionCwd, input.path) : undefined,
      isolation: "shared",
      network_access: network,
      service: input.service,
      target: input.target,
      current_cost_usd: round4(costUsd),
    });
  };

  const blocked = (input: BlockedInput): never => {
    const reason = input.reason.trim();
    if (!reason) throw new Error("ctx.blocked() requires a reason");
    transcript("run.blocked", {
      reason,
      ...(input.decision ? { decision_id: input.decision } : {}),
    });
    throw new WorkflowBlockedError(reason, input.decision);
  };

  const ctx: WorkflowContext = {
    agent,
    parallel,
    stage,
    log,
    evidence,
    authorize,
    blocked,
  };
  try {
    if (resumeState) {
      transcript("run.resume", {
        approval_id: resumeState.approvalId,
        script: absScript,
        resumed_at: new Date().toISOString(),
      });
    } else {
      transcript("run.start", {
        name,
        script: absScript,
        objective: meta.objective ?? null,
        acceptance: meta.acceptance,
        max_agents: maxAgents,
        concurrency,
        specialists: Object.keys(specialists),
        policy: policy ? { name: policy.name, sha256: policyDigest(policy) } : null,
        isolation: "shared",
        network_access: networkAccess,
      });
    }
    const result = await workflow(ctx);
    if (terminalRecordingError) throw terminalRecordingError;
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    transcript("run.end", {
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
        transcriptPath,
        before: executionRepoBefore,
        after: snapshotRepo(executionCwd),
        agents: Array.from(agentProofs.values()),
        evidence: evidenceRecords,
        adapterEvidence: opts.adapterEvidence,
        adapterAttestations: opts.adapterAttestations,
        sandboxProjection: sandboxProjectionEvidence(filesystemPolicy),
        policy: policy
          ? {
              config: policy,
              decisions: Array.from(policyDecisions.values()),
              isolation: "shared",
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
      transcriptPath,
      proofPath,
      acceptance: proof.acceptance.summary,
      contextTokensPerChildEstimate,
      billing: Array.from(billingProbed.values()).map((p) => ({
        adapter: p.adapter,
        mode: subscriptionOnly ? "subscription" : p.mode,
      })),
      policy: proof.policy?.summary,
    };
    return report;
  } catch (err) {
    if (err instanceof WorkflowParkedError) {
      throw err;
    }
    if (err instanceof WorkflowRunError) throw err;
    const endedAt = new Date().toISOString();
    const durationMs = Date.now() - t0;
    transcript("run.end", {
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
        transcriptPath,
        before: executionRepoBefore,
        after: snapshotRepo(executionCwd),
        agents: Array.from(agentProofs.values()),
        evidence: evidenceRecords,
        adapterEvidence: opts.adapterEvidence,
        adapterAttestations: opts.adapterAttestations,
        sandboxProjection: sandboxProjectionEvidence(filesystemPolicy),
        policy: policy
          ? {
              config: policy,
              decisions: Array.from(policyDecisions.values()),
              isolation: "shared",
              networkAccess,
            }
          : undefined,
        error: (err as Error).message,
        // A deliberate stop-on-human, not a work failure. Overrides whatever the
        // agents' own classes would have derived: the script's determination is
        // the more specific fact about why this run ended.
        blocked:
          err instanceof WorkflowBlockedError
            ? { reason: err.reason, decisionId: err.decisionId }
            : undefined,
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

const MAX_SCHEMA_RETRY_REPLY = 16_000;

function withSchemaContract(prompt: string, schema: StageSchema): string {
  return (
    `${prompt}\n\nOutput contract:\n` +
    `Return ONLY one JSON value matching this schema. Do not use prose or code fences.\n` +
    `${JSON.stringify(schema)}`
  );
}

function boundedSchemaReply(value: string): string {
  if (value.length <= MAX_SCHEMA_RETRY_REPLY) return value;
  return `${value.slice(0, MAX_SCHEMA_RETRY_REPLY)}\n[truncated by Harnery]`;
}

/** Stable identity for one agent() call, for the resume cache. The ORIGINAL
 * prompt (never a retry-mutated one) plus everything that changes behavior. */
/**
 * Lower one worker's model and effort to the helper limit for its adapter.
 * Returns the script's own options object untouched when nothing changes, and a
 * new object otherwise; the script's object is never mutated. An adapter with
 * no rankings, a worker that names no model, and a worker at or below the limit
 * are all left alone.
 */
function applyHelperLimit(
  agentOpts: AgentOpts,
  adapter: AdapterName,
  resolveLimit: EngineOpts["helperLimit"],
): { opts: AgentOpts; lowered: boolean } {
  if (!resolveLimit) return { opts: agentOpts, lowered: false };
  const limit = resolveLimit(adapter);
  const profile = builtinAdapterProfile(adapter);
  if (!limit || !profile) return { opts: agentOpts, lowered: false };
  const decision = decideHelperLimit(
    { model: agentOpts.model, effort: agentOpts.effort },
    limit,
    helperLadders(profile),
  );
  if (!decision.changed) return { opts: agentOpts, lowered: false };
  const lowered: AgentOpts = { ...agentOpts };
  if (decision.model !== undefined) lowered.model = decision.model;
  if (decision.effort === undefined) delete lowered.effort;
  else lowered.effort = decision.effort;
  return { opts: lowered, lowered: true };
}

function agentCallKey(
  stage: string,
  adapter: string,
  agentOpts: AgentOpts,
  prompt: string,
): string {
  const parts: unknown[] = [
    stage,
    adapter,
    agentOpts.model ?? null,
    agentOpts.effort ?? null,
    agentOpts.maxTurns ?? DEFAULT_MAX_TURNS,
    agentOpts.schema ?? null,
  ];
  if (agentOpts.specialist) parts.push(agentOpts.specialist);
  // Appended only when set so existing resume keys stay stable.
  if (agentOpts.mcp) parts.push({ mcp: agentOpts.mcp });
  parts.push(prompt);
  const basis = JSON.stringify(parts);
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

/** Load a prior run's transcript into a key → result map. Only `agent.end`
 * entries (completed, validated) are resumable; failed or retried-out agents
 * re-run live. Unreadable transcript → error (a typo'd run id should fail loud,
 * not silently run everything fresh). */
function loadResumeCache(
  coordRoot: string,
  resumeFrom: string,
): Map<string, { kind: "json" | "text"; value: unknown }> {
  const path = join(coordRoot, ".harnery", "workflows", resumeFrom, "transcript.jsonl");
  if (!existsSync(path)) {
    throw new Error(`--resume-from ${resumeFrom}: no transcript at ${path}`);
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
      if (
        e.event === "agent.end" &&
        e.key &&
        (e.result_kind === "json" || e.result_kind === "text") &&
        "result" in e
      ) {
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
    // A crash mid-append leaves a torn last line, which is exactly the run a
    // resume is for. Skip it, as loadResumeCache does for the same file.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const event = parsed as {
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
