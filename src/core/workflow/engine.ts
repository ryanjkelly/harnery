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
import type {
  AgentOpts,
  EngineOpts,
  HarnessName,
  RunReport,
  SpawnResult,
  WorkflowContext,
  WorkflowModule,
} from "./types.ts";
import { parseStageOutput, validateAgainstSchema } from "./validate.ts";

const DEFAULT_MAX_AGENTS = 50;
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_TURNS = 25;

export async function runWorkflow(scriptPath: string, opts: EngineOpts): Promise<RunReport> {
  const absScript = isAbsolute(scriptPath) ? scriptPath : resolve(process.cwd(), scriptPath);
  const mod = (await import(pathToFileURL(absScript).href)) as WorkflowModule;
  if (typeof mod.default !== "function") {
    throw new Error(`${scriptPath}: workflow script must \`export default async (ctx) => …\``);
  }
  const name = mod.meta?.name ?? scriptPath.replace(/^.*\//, "").replace(/\.[cm]?js$/, "");

  const runId = `wf-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = join(opts.coordRoot, ".harnery", "workflows", runId);
  mkdirSync(runDir, { recursive: true });
  const journalPath = join(runDir, "journal.jsonl");

  const maxAgents = opts.maxAgents ?? DEFAULT_MAX_AGENTS;
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
  const cwd = opts.cwd ?? opts.coordRoot;
  const log = opts.onLog ?? ((line: string) => process.stderr.write(`${line}\n`));
  const defaultHarness: HarnessName = opts.defaultHarness ?? "claude-code";

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

  const journal = (event: string, data: Record<string, unknown>): void => {
    const line = JSON.stringify({
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
    const maxAttempts = agentOpts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    // Call identity for resume: same stage + harness + model + turns + schema
    // + ORIGINAL prompt → same key. Retry-mutated prompts never enter the key.
    const key = agentCallKey(currentStage, harness, agentOpts, prompt);
    const cached = resumeCache.get(key);
    if (cached) {
      agentsCached++;
      journal("agent.cached", { id, label, key, kind: cached.kind });
      log(
        `[${name}] ${currentStage || "(no stage)"} → ${id} ${label} (cached from ${opts.resumeFrom})`,
      );
      return cached.value;
    }

    if (agentsSpawned >= maxAgents) {
      throw new Error(
        `workflow agent cap reached (${maxAgents}); raise --max-agents deliberately if the fan-out is intended`,
      );
    }
    agentsSpawned++;

    await acquire();
    try {
      journal("agent.start", { id, label, key, harness, model: agentOpts.model ?? null });
      log(`[${name}] ${currentStage || "(no stage)"} → ${id} [${harness}] ${label}`);

      let attemptPrompt = prompt;
      let last: SpawnResult | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        last = await spawner({
          prompt: attemptPrompt,
          model: agentOpts.model,
          timeoutMs: agentOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxTurns: agentOpts.maxTurns ?? DEFAULT_MAX_TURNS,
          cwd,
          runId,
        });
        costUsd += last.costUsd ?? 0;

        if (!last.ok) {
          journal("agent.attempt_failed", { id, attempt, error: last.error });
          continue; // spawn-level failure: retry with the original prompt
        }
        if (!agentOpts.schema) {
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
      journal("agent.failed", { id, error: reason });
      throw new Error(`agent ${id} (${label}): ${reason}`);
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

  const ctx: WorkflowContext = { agent, parallel, stage, log };

  const t0 = Date.now();
  journal("run.start", { name, script: absScript, max_agents: maxAgents, concurrency });
  try {
    const result = await mod.default(ctx);
    const report: RunReport = {
      runId,
      name,
      result,
      agentsSpawned,
      agentsCached,
      costUsd: round4(costUsd),
      durationMs: Date.now() - t0,
      journalPath,
      contextTokensPerChildEstimate,
    };
    journal("run.end", {
      ok: true,
      agents: agentsSpawned,
      cached: agentsCached,
      cost_usd: report.costUsd,
      duration_ms: report.durationMs,
    });
    return report;
  } catch (err) {
    journal("run.end", {
      ok: false,
      error: (err as Error).message,
      agents: agentsSpawned,
      cached: agentsCached,
      cost_usd: round4(costUsd),
    });
    throw err;
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
