import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWorkflow } from "./engine.ts";
import type { Spawner, WorkflowProof } from "./types.ts";

let root: string;
let sequence = 0;

beforeEach(() => {
  root = join(tmpdir(), `workflow-policy-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(join(root, ".harnery"), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function script(body: string): string {
  const path = join(root, `workflow-${++sequence}.mjs`);
  writeFileSync(path, body);
  return path;
}

function latestProof(): WorkflowProof {
  const workflows = join(root, ".harnery", "workflows");
  const run = readdirSync(workflows).sort().at(-1);
  if (!run) throw new Error("no workflow run");
  return JSON.parse(readFileSync(join(workflows, run, "proof.json"), "utf8")) as WorkflowProof;
}

const quiet = { onLog: () => {} };

describe("workflow policy enforcement", () => {
  test("denied dispatch reaches neither billing probe nor spawner and writes proof", async () => {
    let probes = 0;
    let spawns = 0;
    const spawner: Spawner = async () => {
      spawns++;
      return { ok: true, text: "done", durationMs: 1 };
    };
    await expect(
      runWorkflow(script(`export default ({ agent }) => agent("work")`), {
        coordRoot: root,
        spawners: { "claude-code": spawner },
        policy: { allowed_harnesses: ["codex"], network: "allow" },
        probeBilling: () => {
          probes++;
          return {
            harness: "claude-code",
            apiKeySource: null,
            apiKeyPresent: false,
            login: "present",
            mode: "subscription",
          };
        },
        ...quiet,
      }),
    ).rejects.toThrow(/denied dispatch/);
    expect(probes).toBe(0);
    expect(spawns).toBe(0);
    const proof = latestProof();
    expect(proof.policy?.summary).toEqual({ allowed: 0, denied: 1, asked: 0, total: 1 });
    expect(proof.policy?.decisions[0]?.rule_codes).toContain("harness_not_allowed");
  });

  test("ASK is fail-closed without a host resolver", async () => {
    let spawns = 0;
    await expect(
      runWorkflow(script(`export default ({ agent }) => agent("work")`), {
        coordRoot: root,
        spawners: {
          "claude-code": async () => {
            spawns++;
            return { ok: true, text: "done", durationMs: 1 };
          },
        },
        policy: { network: "ask" },
        networkAccess: "enabled",
        ...quiet,
      }),
    ).rejects.toThrow(/no host approval resolver/);
    expect(spawns).toBe(0);
    const decision = latestProof().policy?.decisions[0];
    expect(decision?.initial_verdict).toBe("ask");
    expect(decision?.verdict).toBe("deny");
    expect(decision?.resolved_by).toBe("fail_closed");
  });

  test("host approval can allow ASK and is preserved in proof", async () => {
    const report = await runWorkflow(script(`export default ({ agent }) => agent("work")`), {
      coordRoot: root,
      spawners: {
        "claude-code": async () => ({ ok: true, text: "done", durationMs: 1, costUsd: 0.1 }),
      },
      probeBilling: () => ({
        harness: "claude-code",
        apiKeySource: null,
        apiKeyPresent: false,
        login: "present",
        mode: "subscription",
      }),
      policy: { network: "ask" },
      networkAccess: "enabled",
      resolvePolicyAsk: async () => ({ verdict: "allow", reason: "operator approved" }),
      ...quiet,
    });
    expect(report.agentsSpawned).toBe(1);
    expect(report.policy).toEqual({ allowed: 1, denied: 0, asked: 1, total: 1 });
    const decision = latestProof().policy?.decisions[0];
    expect(decision?.resolved_by).toBe("host");
    expect(decision?.reason).toBe("operator approved");
  });

  test("unknown pricing under a ceiling denies before spawn", async () => {
    let spawns = 0;
    await expect(
      runWorkflow(script(`export default ({ agent }) => agent("work")`), {
        coordRoot: root,
        spawners: {
          "claude-code": async () => {
            spawns++;
            return { ok: true, text: "done", durationMs: 1 };
          },
        },
        policy: { max_cost_usd: 1, network: "allow" },
        estimateDispatchCost: async () => {
          throw new Error("catalog offline");
        },
        ...quiet,
      }),
    ).rejects.toThrow(/dispatch cost is unknown/);
    expect(spawns).toBe(0);
    expect(latestProof().policy?.decisions[0]?.rule_codes).toContain("dispatch_cost_unknown");
  });

  test("parallel dispatches reserve projected cost before spawning", async () => {
    let spawns = 0;
    const report = await runWorkflow(
      script(`
        export default ({ agent, parallel }) =>
          parallel([() => agent("one"), () => agent("two")]);
      `),
      {
        coordRoot: root,
        spawners: {
          "claude-code": async () => {
            spawns++;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { ok: true, text: "done", durationMs: 10, costUsd: 0.6 };
          },
        },
        probeBilling: () => ({
          harness: "claude-code",
          apiKeySource: null,
          apiKeyPresent: false,
          login: "present",
          mode: "subscription",
        }),
        policy: { max_cost_usd: 1, network: "allow" },
        estimateDispatchCost: () => 0.6,
        ...quiet,
      },
    );
    expect(spawns).toBe(1);
    expect(report.result).toEqual(["done", null]);
    expect(report.policy).toEqual({ allowed: 1, denied: 1, asked: 0, total: 2 });
  });

  test("external mutation authorization denies before workflow side effects", async () => {
    const marker = join(root, "published.txt");
    await expect(
      runWorkflow(
        script(`
          import { writeFileSync } from "node:fs";
          export default async ({ authorize }) => {
            await authorize({ action: "publish release", network: true, service: "registry" });
            writeFileSync(${JSON.stringify(marker)}, "published");
          };
        `),
        {
          coordRoot: root,
          spawners: {},
          policy: { external_actions: "allow", network: "deny" },
          ...quiet,
        },
      ),
    ).rejects.toThrow(/denied external_mutation/);
    expect(existsSync(marker)).toBe(false);
    expect(latestProof().policy?.decisions[0]?.request.service).toBe("registry");
  });

  test("a throwing approval resolver fails closed", async () => {
    await expect(
      runWorkflow(script(`export default ({ agent }) => agent("work")`), {
        coordRoot: root,
        spawners: { "claude-code": async () => ({ ok: true, text: "done", durationMs: 1 }) },
        policy: { network: "ask" },
        networkAccess: "enabled",
        resolvePolicyAsk: async () => {
          throw new Error("approval service offline");
        },
        ...quiet,
      }),
    ).rejects.toThrow(/approval failed closed/);
    expect(latestProof().policy?.decisions[0]?.resolved_by).toBe("fail_closed");
  });

  test("an approval timeout fails closed", async () => {
    await expect(
      runWorkflow(script(`export default ({ agent }) => agent("work")`), {
        coordRoot: root,
        spawners: { "claude-code": async () => ({ ok: true, text: "done", durationMs: 1 }) },
        policy: { network: "ask" },
        networkAccess: "enabled",
        resolvePolicyAsk: () => new Promise(() => {}),
        policyAskTimeoutMs: 5,
        ...quiet,
      }),
    ).rejects.toThrow(/approval timed out after 5ms/);
    expect(latestProof().policy?.decisions[0]?.verdict).toBe("deny");
  });

  test("the bounded policy receipt cap fails closed", async () => {
    await expect(
      runWorkflow(
        script(`
          export default async ({ authorize }) => {
            for (let i = 0; i < 51; i++) {
              await authorize({ action: "local mutation " + i, network: false });
            }
          };
        `),
        {
          coordRoot: root,
          spawners: {},
          policy: { external_actions: "allow", network: "allow" },
          ...quiet,
        },
      ),
    ).rejects.toThrow(/policy decision cap reached \(50\)/);
    expect(latestProof().policy?.decisions).toHaveLength(50);
  });
});
