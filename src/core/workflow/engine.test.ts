import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStopHook } from "../agents/rules/stop-hook.ts";
import { runWorkflow } from "./engine.ts";
import type { Spawner, SpawnRequest, SpawnResult, WorkflowProof } from "./types.ts";
import { parseStageOutput, validateAgainstSchema } from "./validate.ts";

let root: string;
let scriptDir: string;
let seq = 0;

beforeEach(() => {
  const tempRoot = process.platform === "linux" ? "/tmp" : tmpdir();
  root = join(
    tempRoot,
    `workflow-engine-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  scriptDir = join(root, "scripts");
  mkdirSync(scriptDir, { recursive: true });
  mkdirSync(join(root, ".harnery"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write a workflow script to disk (dynamic import needs a real file). Unique
 * filename per call: ESM module cache is keyed by URL. */
function writeScript(body: string): string {
  const p = join(scriptDir, `wf-${++seq}.mjs`);
  writeFileSync(p, body, "utf8");
  return p;
}

function okSpawn(text: string, extra: Partial<SpawnResult> = {}): SpawnResult {
  return { ok: true, text, durationMs: 5, costUsd: 0.01, sessionId: "child-s", ...extra };
}

// Hermetic defaults: silence progress AND stub the billing probe so tests
// never depend on the machine's real credential files / exported keys.
const quiet = {
  onLog: () => {},
  probeBilling: (harness: string) => ({
    harness,
    apiKeySource: null,
    apiKeyPresent: false,
    login: "present" as const,
    mode: "subscription" as const,
  }),
};

describe("runWorkflow", () => {
  test("schema-gated agent returns validated JSON; report totals populated", async () => {
    const spawner: Spawner = async () => okSpawn('{"route": "keep", "reason": "fine"}');
    const script = writeScript(`
      export const meta = { name: "t1" };
      export default async ({ agent, stage }) => {
        stage("triage");
        return await agent("classify", { schema: {
          type: "object", required: ["route", "reason"],
          properties: { route: { enum: ["close", "analyze", "keep"] }, reason: { type: "string" } },
        }});
      };
    `);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
    });
    expect(report.result).toEqual({ route: "keep", reason: "fine" });
    expect(report.agentsSpawned).toBe(1);
    expect(report.costUsd).toBeCloseTo(0.01, 5);
    expect(report.name).toBe("t1");
  });

  test("schema mismatch retries with problems fed back, then succeeds", async () => {
    const prompts: string[] = [];
    const spawner: Spawner = async (req: SpawnRequest) => {
      prompts.push(req.prompt);
      return prompts.length === 1
        ? okSpawn('{"route": "maybe"}') // bad enum + missing reason
        : okSpawn('{"route": "close", "reason": "stale"}');
    };
    const script = writeScript(`
      export default async ({ agent }) => agent("classify", { schema: {
        type: "object", required: ["route", "reason"],
        properties: { route: { enum: ["close", "analyze", "keep"] }, reason: { type: "string" } },
      }});
    `);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
    });
    expect(report.result).toEqual({ route: "close", reason: "stale" });
    expect(prompts.length).toBe(2);
    // Retry prompt carries the validation problems verbatim.
    expect(prompts[1]).toContain("failed validation");
    expect(prompts[1]).toContain("required property missing");
  });

  test("retry exhaustion throws and journals agent.failed + run.end ok:false", async () => {
    const spawner: Spawner = async () => okSpawn("not json at all");
    const script = writeScript(`
      export default async ({ agent }) => agent("classify", {
        schema: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
        maxAttempts: 2,
      });
    `);
    await expect(
      runWorkflow(script, { coordRoot: root, spawners: { "claude-code": spawner }, ...quiet }),
    ).rejects.toThrow(/schema validation failed after 2 attempt/);
    const journal = readJournal();
    expect(journal.some((e) => e.event === "agent.failed")).toBe(true);
    const end = journal.find((e) => e.event === "run.end");
    expect(end?.ok).toBe(false);
  });

  test("maxAgents cap: excess parallel items fail to null, direct call throws", async () => {
    const spawner: Spawner = async () => okSpawn("text");
    const script = writeScript(`
      export default async ({ agent, parallel }) => {
        const results = await parallel([1, 2, 3].map((i) => () => agent("job " + i)));
        return results.filter((r) => r !== null).length;
      };
    `);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      maxAgents: 2,
      ...quiet,
    });
    expect(report.result).toBe(2); // third item hit the cap -> null
    expect(report.agentsSpawned).toBe(2);
  });

  test("rejects non-positive execution bounds before a run can deadlock", async () => {
    const script = writeScript(`export default async () => "done";`);
    await expect(
      runWorkflow(script, {
        coordRoot: root,
        spawners: {},
        concurrency: 0,
        ...quiet,
      }),
    ).rejects.toThrow(/concurrency must be a positive safe integer/);
  });

  test("parallel() bounds real concurrency to the shared pool", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const spawner: Spawner = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return okSpawn("done");
    };
    const script = writeScript(`
      export default async ({ agent, parallel }) =>
        parallel(Array.from({ length: 6 }, (_, i) => () => agent("job " + i)));
    `);
    await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      concurrency: 2,
      ...quiet,
    });
    expect(maxInFlight).toBe(2);
  });

  test("agent without schema returns raw text; journal has stage + session id", async () => {
    const spawner: Spawner = async () => okSpawn("plain reply");
    const script = writeScript(`
      export default async ({ agent, stage }) => {
        stage("explore");
        return agent("look around");
      };
    `);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
    });
    expect(report.result).toBe("plain reply");
    const journal = readJournal();
    expect(journal.find((e) => e.event === "stage.start")?.title).toBe("explore");
    const end = journal.find((e) => e.event === "agent.end");
    expect(end?.stage).toBe("explore");
    expect(end?.session_id).toBe("child-s");
  });

  test("effort reaches the adapter and participates in resume identity", async () => {
    const requests: SpawnRequest[] = [];
    const spawner: Spawner = async (req) => {
      requests.push(req);
      return okSpawn(`reply-${req.effort}`);
    };
    const firstScript = writeScript(`
      export default async ({ agent }) => agent("inspect", { effort: "high" });
    `);
    const first = await runWorkflow(firstScript, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
    });
    expect(requests[0]?.effort).toBe("high");

    const changedEffortScript = writeScript(`
      export default async ({ agent }) => agent("inspect", { effort: "low" });
    `);
    const second = await runWorkflow(changedEffortScript, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      resumeFrom: first.runId,
      ...quiet,
    });
    expect(second.agentsCached).toBe(0);
    expect(requests[1]?.effort).toBe("low");
  });

  test("specialist profiles freeze role instructions and dispatch defaults", async () => {
    const requests: SpawnRequest[] = [];
    const spawner: Spawner = async (req) => {
      requests.push(req);
      return okSpawn("reviewed");
    };
    const script = writeScript(`
      export default async ({ agent }) => agent("Inspect the patch", { specialist: "reviewer" });
    `);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { codex: spawner },
      specialists: {
        reviewer: {
          instructions: "You are the independent reviewer. Report concrete defects.",
          harness: "codex",
          model: "review-model",
          effort: "high",
          maxTurns: 12,
          timeoutMs: 45_000,
        },
      },
      ...quiet,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.prompt).toStartWith("You are the independent reviewer");
    expect(requests[0]?.prompt).toContain("Assignment:\nInspect the patch");
    expect(requests[0]?.model).toBe("review-model");
    expect(requests[0]?.effort).toBe("high");
    expect(requests[0]?.maxTurns).toBe(12);
    expect(requests[0]?.timeoutMs).toBe(45_000);
    const manifest = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", report.runId, "run.json"), "utf8"),
    );
    expect(manifest.execution.specialists.reviewer.instructions).toContain("independent reviewer");
    const proof = JSON.parse(
      readFileSync(join(root, ".harnery", "workflows", report.runId, "proof.json"), "utf8"),
    );
    expect(proof.agents[0].specialist).toBe("reviewer");
  });

  test("specialist identity participates in resume caching and unknown roles fail closed", async () => {
    let calls = 0;
    const spawner: Spawner = async () => {
      calls++;
      return okSpawn("done");
    };
    const script = writeScript(`
      export default async ({ agent }) => agent("Inspect", { specialist: "reviewer" });
    `);
    const first = await runWorkflow(script, {
      coordRoot: root,
      spawners: { codex: spawner },
      specialists: { reviewer: { instructions: "Review version one", harness: "codex" } },
      ...quiet,
    });
    const changed = await runWorkflow(
      writeScript(`
      export default async ({ agent }) => agent("Inspect", { specialist: "reviewer" });
    `),
      {
        coordRoot: root,
        spawners: { codex: spawner },
        resumeFrom: first.runId,
        specialists: { reviewer: { instructions: "Review version two", harness: "codex" } },
        ...quiet,
      },
    );
    expect(changed.agentsCached).toBe(0);
    expect(calls).toBe(2);
    await expect(
      runWorkflow(
        writeScript(`
        export default async ({ agent }) => agent("Inspect", { specialist: "missing" });
      `),
        {
          coordRoot: root,
          spawners: { codex: spawner },
          specialists: { reviewer: { instructions: "Review", harness: "codex" } },
          ...quiet,
        },
      ),
    ).rejects.toThrow(/specialist "missing" is not configured/);
  });

  test("spawn-level failure retries, then surfaces the spawn error", async () => {
    let calls = 0;
    const spawner: Spawner = async () => {
      calls++;
      return { ok: false, text: "", durationMs: 1, error: "claude exited 1: boom" };
    };
    const script = writeScript(`export default async ({ agent }) => agent("x");`);
    await expect(
      runWorkflow(script, { coordRoot: root, spawners: { "claude-code": spawner }, ...quiet }),
    ).rejects.toThrow(/claude exited 1: boom/);
    expect(calls).toBe(2); // DEFAULT_MAX_ATTEMPTS
  });

  test("script without default export fails loud", async () => {
    const script = writeScript(`export const meta = { name: "no-fn" };`);
    const spawner: Spawner = async () => okSpawn("x");
    await expect(
      runWorkflow(script, { coordRoot: root, spawners: { "claude-code": spawner }, ...quiet }),
    ).rejects.toThrow(/export default/);
  });

  test("per-agent harness routes to the matching spawner; unknown harness fails loud", async () => {
    const seen: string[] = [];
    const mk =
      (tag: string): Spawner =>
      async () => {
        seen.push(tag);
        return okSpawn(`${tag} reply`);
      };
    const script = writeScript(`
      export default async ({ agent }) => {
        const a = await agent("one");                          // default harness
        const b = await agent("two", { harness: "codex" });    // explicit route
        return [a, b];
      };
    `);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": mk("cc"), codex: mk("cx") },
      ...quiet,
    });
    expect(report.result).toEqual(["cc reply", "cx reply"]);
    expect(seen).toEqual(["cc", "cx"]);

    const script2 = writeScript(
      `export default async ({ agent }) => agent("x", { harness: "cursor" });`,
    );
    await expect(
      runWorkflow(script2, { coordRoot: root, spawners: { "claude-code": mk("cc") }, ...quiet }),
    ).rejects.toThrow(/no spawner registered for harness "cursor"/);
  });

  test("resume-from reuses journaled results; only new calls spawn", async () => {
    let calls = 0;
    const spawner: Spawner = async (req: SpawnRequest) => {
      calls++;
      return req.prompt.startsWith("classify")
        ? okSpawn('{"route": "keep", "reason": "r"}')
        : okSpawn("fresh text");
    };
    const body = `
      export default async ({ agent, stage }) => {
        stage("triage");
        const v = await agent("classify item-1", { schema: {
          type: "object", required: ["route", "reason"],
          properties: { route: { enum: ["close", "analyze", "keep"] }, reason: { type: "string" } },
        }});
        const t = await agent("summarize item-1");
        return [v, t];
      };
    `;
    const script = writeScript(body);
    const first = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
    });
    expect(calls).toBe(2);
    expect(first.agentsCached).toBe(0);

    // Same script re-run with --resume-from: zero live spawns, same results.
    const script2 = writeScript(body);
    const second = await runWorkflow(script2, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      resumeFrom: first.runId,
      ...quiet,
    });
    expect(calls).toBe(2); // unchanged — nothing spawned
    expect(second.agentsSpawned).toBe(0);
    expect(second.agentsCached).toBe(2);
    expect(second.result).toEqual(first.result);
  });

  test("resume-from with a changed prompt re-runs only the changed call", async () => {
    let calls = 0;
    const spawner: Spawner = async () => {
      calls++;
      return okSpawn("t");
    };
    const first = await runWorkflow(
      writeScript(
        `export default async ({ agent }) => [await agent("stable"), await agent("v1")];`,
      ),
      { coordRoot: root, spawners: { "claude-code": spawner }, ...quiet },
    );
    expect(calls).toBe(2);
    const second = await runWorkflow(
      writeScript(
        `export default async ({ agent }) => [await agent("stable"), await agent("v2")];`,
      ),
      { coordRoot: root, spawners: { "claude-code": spawner }, resumeFrom: first.runId, ...quiet },
    );
    expect(calls).toBe(3); // only "v2" spawned live
    expect(second.agentsCached).toBe(1);
    expect(second.agentsSpawned).toBe(1);
  });

  test("resume-from a nonexistent run id fails loud", async () => {
    const spawner: Spawner = async () => okSpawn("x");
    const script = writeScript(`export default async ({ agent }) => agent("x");`);
    await expect(
      runWorkflow(script, {
        coordRoot: root,
        spawners: { "claude-code": spawner },
        resumeFrom: "wf-typo",
        ...quiet,
      }),
    ).rejects.toThrow(/no journal at/);
  });

  test("context-cost estimate: reads instructions file size, lands in report + runId reaches spawner", async () => {
    // 40KB CLAUDE.md at the child cwd → ~10K tokens estimated.
    writeFileSync(join(root, "CLAUDE.md"), "x".repeat(40_000), "utf8");
    let seenRunId: string | undefined;
    const spawner: Spawner = async (req: SpawnRequest) => {
      seenRunId = req.runId;
      return okSpawn("y");
    };
    const script = writeScript(`export default async ({ agent }) => agent("x");`);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
    });
    expect(report.contextTokensPerChildEstimate).toBe(10_000);
    expect(seenRunId).toBe(report.runId);
  });

  test("writes a private proof packet with acceptance receipts, digests, repository drift, and normalized journals", async () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "workflow-test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: root });
    writeFileSync(join(root, "base.txt"), "base\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });

    const artifactPath = join(root, "proof-artifact.txt");
    const script = writeScript(`
      import { writeFileSync } from "node:fs";
      export const meta = {
        name: "proof-run",
        objective: "Produce an inspectable artifact",
        acceptance: [{ id: "artifact", statement: "The artifact exists" }],
      };
      export default async ({ agent, evidence }) => {
        const result = await agent("produce the private value");
        writeFileSync(${JSON.stringify(artifactPath)}, "artifact\\n", "utf8");
        evidence({
          kind: "artifact",
          status: "passed",
          label: "Artifact written",
          ref: ${JSON.stringify(artifactPath)},
          acceptanceIds: ["artifact"],
        });
        return { complete: true, result };
      };
    `);
    const report = await runWorkflow(script, {
      coordRoot: root,
      cwd: root,
      spawners: { codex: async () => okSpawn("TOP_SECRET_REPLY") },
      defaultHarness: "codex",
      harnessEvidence: {
        codex: {
          toolEvidence: {
            support: "unsupported",
            note: "The final-result adapter does not retain tool events.",
          },
        },
      },
      ...quiet,
    });

    expect(report.proofPath).toEndWith("proof.json");
    expect(report.acceptance).toEqual({ satisfied: 1, unsatisfied: 0, unknown: 0, total: 1 });
    expect(statSync(report.proofPath).mode & 0o777).toBe(0o600);
    const proof = JSON.parse(readFileSync(report.proofPath, "utf8")) as WorkflowProof;
    expect(proof.schema_version).toBe(1);
    expect(proof.run.status).toBe("succeeded");
    expect(proof.acceptance.criteria[0]?.status).toBe("satisfied");
    expect(proof.evidence[0]?.source).toBe("workflow");
    expect(proof.repository.source).toBe("engine");
    expect(proof.repository.drift.dirty_paths_added).toContain("proof-artifact.txt");
    expect(proof.agents[0]?.result?.sha256).toHaveLength(64);
    expect(JSON.stringify(proof)).not.toContain("TOP_SECRET_REPLY");
    expect(JSON.stringify(proof)).not.toContain("produce the private value");
    expect(proof.unknowns.some((item) => item.code === "tool_evidence_unavailable")).toBe(true);

    const journal = readJournal();
    expect(journal.every((event) => event.schema_version === 1)).toBe(true);
    expect(journal.every((event) => event.run_id === report.runId)).toBe(true);
    expect(proof.integrity.journal.bytes).toBe(statSync(report.journalPath).size);
  });

  test("a failed workflow still writes a terminal proof packet and exposes its path", async () => {
    const script = writeScript(`
      export const meta = {
        name: "failed-proof",
        acceptance: [{ id: "check", statement: "The check passes" }],
      };
      export default async ({ evidence }) => {
        evidence({ kind: "test", status: "failed", label: "Focused test", acceptanceIds: ["check"] });
        throw new Error("deliberate workflow failure");
      };
    `);
    try {
      await runWorkflow(script, {
        coordRoot: root,
        spawners: { "claude-code": async () => okSpawn("unused") },
        ...quiet,
      });
      throw new Error("expected workflow failure");
    } catch (error) {
      expect((error as Error).message).toContain("deliberate workflow failure");
      const proofPath = (error as Error & { proofPath?: string }).proofPath;
      expect(proofPath).toBeString();
      expect(existsSync(proofPath as string)).toBe(true);
      const proof = JSON.parse(readFileSync(proofPath as string, "utf8")) as WorkflowProof;
      expect(proof.run.status).toBe("failed");
      expect(proof.run.error).toBe("deliberate workflow failure");
      expect(proof.acceptance.criteria[0]?.status).toBe("unsatisfied");
    }
  });

  function readJournal(): Array<Record<string, unknown> & { event: string }> {
    const dir = join(root, ".harnery", "workflows");
    expect(existsSync(dir)).toBe(true);
    const runDir = join(dir, readdirSync(dir)[0] as string);
    return readFileSync(join(runDir, "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  }
});

describe("parseCursorOutput", () => {
  test("json envelope, error envelope, and non-json fallback", async () => {
    const { parseCursorOutput } = await import("./spawn-cursor.ts");
    expect(parseCursorOutput('{"type":"result","result":"hi","session_id":"s1"}')).toEqual({
      text: "hi",
      sessionId: "s1",
      isError: false,
    });
    expect(parseCursorOutput('{"is_error":true,"result":"boom"}').isError).toBe(true);
    expect(parseCursorOutput("plain text").text).toBe("plain text");
  });
});

describe("validate", () => {
  test("nested object/array/enum problems carry paths", () => {
    const schema = {
      type: "array" as const,
      items: {
        type: "object" as const,
        required: ["id"],
        properties: { id: { type: "number" as const }, tag: { enum: ["a", "b"] as const } },
      },
    };
    const problems = validateAgainstSchema([{ id: 1 }, { tag: "c" }], schema as never);
    expect(problems).toEqual([
      "$[1].id: required property missing",
      '$[1].tag: expected one of ["a","b"], got "c"',
    ]);
  });

  test("parseStageOutput strips code fences", () => {
    expect(parseStageOutput('```json\n{"ok": true}\n```').value).toEqual({ ok: true });
    expect(parseStageOutput("nope").error).toContain("not valid JSON");
  });
});

describe("stop-hook workflow-child exemption", () => {
  test("workflow_child allows without reading events", () => {
    const verdict = evaluateStopHook(root, {
      rule: "stop-hook",
      instance_id: "any",
      workflow_child: true,
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.rule).toBe("stop-hook.workflow_child");
  });
});

describe("billing safeguards", () => {
  const overrideProbe = (harness: string) => ({
    harness,
    apiKeySource: "ANTHROPIC_API_KEY",
    apiKeyPresent: true,
    login: "present" as const,
    mode: "api-key-override" as const,
  });

  test("api-key-override is refused with actionable guidance", async () => {
    const spawner: Spawner = async () => okSpawn("hi");
    const script = writeScript(`export default async ({ agent }) => agent("go");`);
    await expect(
      runWorkflow(script, {
        coordRoot: root,
        spawners: { "claude-code": spawner },
        ...quiet,
        probeBilling: overrideProbe,
      }),
    ).rejects.toThrow(/silently\s+overrides.*--subscription-only.*--allow-api-billing/s);
  });

  test("--allow-api-billing permits the override state", async () => {
    const spawner: Spawner = async () => okSpawn("hi");
    const script = writeScript(`export default async ({ agent }) => agent("go");`);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
      probeBilling: overrideProbe,
      allowApiBilling: true,
    });
    expect(report.result).toBe("hi");
    expect(report.billing).toEqual([{ harness: "claude-code", mode: "api-key-override" }]);
  });

  test("subscription-only fails loud when the stored login is provably absent", async () => {
    const spawner: Spawner = async () => okSpawn("hi");
    const script = writeScript(`export default async ({ agent }) => agent("go");`);
    await expect(
      runWorkflow(script, {
        coordRoot: root,
        spawners: { "claude-code": spawner },
        ...quiet,
        probeBilling: (h) => ({
          harness: h,
          apiKeySource: null,
          apiKeyPresent: false,
          login: "absent" as const,
          mode: "subscription" as const,
        }),
        subscriptionOnly: true,
      }),
    ).rejects.toThrow(/subscription-only: no stored login/);
  });

  test("subscription-only neutralizes an override: run proceeds, spawner told to scrub, mode reports subscription", async () => {
    const requests: SpawnRequest[] = [];
    const spawner: Spawner = async (req) => {
      requests.push(req);
      return okSpawn("hi");
    };
    const script = writeScript(`export default async ({ agent }) => agent("go");`);
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
      probeBilling: overrideProbe,
      subscriptionOnly: true,
    });
    expect(report.result).toBe("hi");
    expect(requests[0]?.subscriptionOnly).toBe(true);
    expect(report.billing).toEqual([{ harness: "claude-code", mode: "subscription" }]);
  });

  test("probe runs once per harness and lands one billing.probe journal event", async () => {
    let probes = 0;
    const spawner: Spawner = async () => okSpawn("hi");
    const script = writeScript(
      `export default async ({ agent }) => { await agent("one"); return agent("two"); };`,
    );
    const report = await runWorkflow(script, {
      coordRoot: root,
      spawners: { "claude-code": spawner },
      ...quiet,
      probeBilling: (h) => {
        probes++;
        return quiet.probeBilling(h);
      },
    });
    expect(probes).toBe(1);
    const journal = readFileSync(report.journalPath, "utf8");
    const billingEvents = journal.split("\n").filter((l) => l.includes('"billing.probe"'));
    expect(billingEvents.length).toBe(1);
    expect(billingEvents[0]).toContain('"mode":"subscription"');
  });
});
