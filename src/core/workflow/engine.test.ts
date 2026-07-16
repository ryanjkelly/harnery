import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateStopHook } from "../agents/rules/stop-hook.ts";
import { runWorkflow } from "./engine.ts";
import type { Spawner, SpawnRequest, SpawnResult } from "./types.ts";
import { parseStageOutput, validateAgainstSchema } from "./validate.ts";

let root: string;
let scriptDir: string;
let seq = 0;

beforeEach(() => {
  root = join(
    tmpdir(),
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

const quiet = { onLog: () => {} };

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
    const report = await runWorkflow(script, { coordRoot: root, spawner, ...quiet });
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
    const report = await runWorkflow(script, { coordRoot: root, spawner, ...quiet });
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
    await expect(runWorkflow(script, { coordRoot: root, spawner, ...quiet })).rejects.toThrow(
      /schema validation failed after 2 attempt/,
    );
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
    const report = await runWorkflow(script, { coordRoot: root, spawner, maxAgents: 2, ...quiet });
    expect(report.result).toBe(2); // third item hit the cap -> null
    expect(report.agentsSpawned).toBe(2);
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
    await runWorkflow(script, { coordRoot: root, spawner, concurrency: 2, ...quiet });
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
    const report = await runWorkflow(script, { coordRoot: root, spawner, ...quiet });
    expect(report.result).toBe("plain reply");
    const journal = readJournal();
    expect(journal.find((e) => e.event === "stage.start")?.title).toBe("explore");
    const end = journal.find((e) => e.event === "agent.end");
    expect(end?.stage).toBe("explore");
    expect(end?.session_id).toBe("child-s");
  });

  test("spawn-level failure retries, then surfaces the spawn error", async () => {
    let calls = 0;
    const spawner: Spawner = async () => {
      calls++;
      return { ok: false, text: "", durationMs: 1, error: "claude exited 1: boom" };
    };
    const script = writeScript(`export default async ({ agent }) => agent("x");`);
    await expect(runWorkflow(script, { coordRoot: root, spawner, ...quiet })).rejects.toThrow(
      /claude exited 1: boom/,
    );
    expect(calls).toBe(2); // DEFAULT_MAX_ATTEMPTS
  });

  test("script without default export fails loud", async () => {
    const script = writeScript(`export const meta = { name: "no-fn" };`);
    const spawner: Spawner = async () => okSpawn("x");
    await expect(runWorkflow(script, { coordRoot: root, spawner, ...quiet })).rejects.toThrow(
      /export default/,
    );
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
