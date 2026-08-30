import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext, loadLazyCommand } from "../commander.ts";
import { createGovernor, runGovernor } from "../core/governor/index.ts";
import { createWorkItem } from "../core/work/index.ts";

const roots: string[] = [];
let cwd: string | undefined;

afterEach(() => {
  if (cwd) {
    process.chdir(cwd);
    cwd = undefined;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function captureEmit(): { emit: EmitContext; text: () => string } {
  let buffer = "";
  const emit: EmitContext = {
    config: () => {},
    data: (payload) => {
      buffer += `${JSON.stringify(payload)}\n`;
    },
    rows: (values) => {
      buffer += `${JSON.stringify(values)}\n`;
    },
    text: (value) => {
      buffer += value;
    },
    file: () => {},
    error: (payload) => {
      buffer += `ERROR ${JSON.stringify(payload)}\n`;
    },
    log: () => {},
    setExitCode: () => {},
  };
  return { emit, text: () => buffer };
}

describe("governor command", () => {
  test("registers the durable goal lifecycle", async () => {
    const program = createHarneryProgram();
    await loadLazyCommand(program, "governor");
    const command = program.commands.find((candidate) => candidate.name() === "governor");
    expect(command).toBeDefined();
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "create",
      "list",
      "show",
      "plan",
      "service",
      "tick",
      "run",
    ]);
    const plan = command?.commands.find((candidate) => candidate.name() === "plan");
    expect(plan?.commands.map((candidate) => candidate.name())).toEqual([
      "list",
      "show",
      "approve",
      "reject",
      "retry",
    ]);
    const service = command?.commands.find((candidate) => candidate.name() === "service");
    expect(service?.commands.map((candidate) => candidate.name())).toEqual([
      "start",
      "run",
      "status",
      "stop",
      "logs",
      "daemon",
    ]);
    const create = command?.commands.find((candidate) => candidate.name() === "create");
    expect(create?.registeredArguments[0]?.required).toBe(false);
    expect(create?.options.map((option) => option.long)).toContain("--mission");
  });

  test("list and show expose planner no-proposal replan exhaustion", async () => {
    cwd = process.cwd();
    const root = mkdtempSync(join("/tmp", "harnery-governor-cli-"));
    roots.push(root);
    const passing = join(root, "passing.mjs");
    writeFileSync(
      passing,
      `export const meta = { name: "passing", acceptance: [{ id: "done", statement: "done" }] };
       export default async ({ agent, evidence }) => {
         const result = await agent("go", { specialist: "planner" });
         evidence({ kind: "review", status: "passed", label: "ok", acceptanceIds: ["done"] });
         return result;
       };\n`,
    );
    const failing = join(root, "failing.mjs");
    writeFileSync(failing, `export default async () => { throw new Error("fail"); };\n`);
    createWorkItem({
      coordRoot: root,
      id: "cli-no-proposal-root",
      title: "CLI no proposal root",
      objective: "Exhaust the replan budget without any proposal",
      workflowPath: failing,
      maxAttempts: 1,
    });
    createGovernor({
      coordRoot: root,
      id: "goal-cli-no-proposal",
      rootWorkId: "cli-no-proposal-root",
      specialists: { planner: { instructions: "Plan", adapter: "codex" } },
      replanning: {
        plannerSpecialist: "planner",
        maxReplans: 1,
        templates: { repair: { workflowPath: passing, root: true } },
      },
    });
    await runGovernor({
      coordRoot: root,
      goalId: "goal-cli-no-proposal",
      engine: {
        spawners: {
          codex: async () => ({
            ok: true,
            text: JSON.stringify({
              decision: "attention",
              rationale: "The goal needs an operator decision",
              root: "",
              work: [],
            }),
            durationMs: 1,
          }),
        },
        probeBilling: (adapter: string) => ({
          adapter,
          apiKeySource: null,
          apiKeyPresent: false,
          login: "present" as const,
          mode: "subscription" as const,
        }),
      },
    });
    process.chdir(root);

    const listed = captureEmit();
    await createHarneryProgram({ emit: listed.emit }).parseAsync([
      "node",
      "harn",
      "governor",
      "list",
    ]);
    expect(listed.text()).toContain("[planner no-proposal x1]");

    const shown = captureEmit();
    await createHarneryProgram({ emit: shown.emit }).parseAsync([
      "node",
      "harn",
      "governor",
      "show",
      "goal-cli-no-proposal",
    ]);
    expect(shown.text()).toContain(
      "replan consumption: planner no-proposal=1, reviewer rejection=0",
    );
    // The distinction must reach the projection.reason field too, not only the
    // consumption line and the list-row suffix: `show` renders `reason:`, so a
    // reader (human or programmatic) is told the planner produced no proposal
    // rather than that review was exhausted.
    expect(shown.text()).toContain("reason: ");
    expect(shown.text()).toContain("producing no proposal");
  });

  test("list reports an unreadable goal without hiding readable goals", async () => {
    cwd = process.cwd();
    const root = mkdtempSync(join("/tmp", "harnery-governor-cli-list-"));
    roots.push(root);
    const workflow = join(root, "workflow.mjs");
    writeFileSync(workflow, "export default async () => 'ok';\n");
    createWorkItem({
      coordRoot: root,
      id: "list-root",
      title: "List root",
      objective: "Keep readable goals visible",
      workflowPath: workflow,
    });
    for (const id of ["goal-cli-readable", "goal-cli-poisoned"]) {
      createGovernor({
        coordRoot: root,
        id,
        rootWorkId: "list-root",
        specialists: { implementer: { instructions: "Implement", adapter: "codex" } },
      });
    }
    const poisonedPath = join(root, ".harnery", "governors", "goal-cli-poisoned", "intent.json");
    const poisoned = JSON.parse(readFileSync(poisonedPath, "utf8")) as {
      specialists: Record<string, Record<string, unknown>>;
    };
    poisoned.specialists.implementer!.harness = "codex";
    writeFileSync(poisonedPath, `${JSON.stringify(poisoned, null, 2)}\n`);
    process.chdir(root);

    const output = captureEmit();
    await createHarneryProgram({ emit: output.emit }).parseAsync([
      "node",
      "harn",
      "governor",
      "list",
    ]);

    expect(output.text()).toContain("goal-cli-readable");
    expect(output.text()).toContain(
      "warning  goal-cli-poisoned  unreadable: governor intent goal-cli-poisoned specialists are not canonical",
    );
    expect(output.text()).not.toContain("ERROR");
  });

  test("create names an unsupported specialist profile key", async () => {
    cwd = process.cwd();
    const root = mkdtempSync(join("/tmp", "harnery-governor-cli-create-"));
    roots.push(root);
    const workflow = join(root, "workflow.mjs");
    const team = join(root, "team.json");
    writeFileSync(workflow, "export default async () => 'ok';\n");
    writeFileSync(
      team,
      `${JSON.stringify({
        implementer: {
          instructions: "Implement",
          adapter: "codex",
          timeoutMs: 60_000,
        },
      })}\n`,
    );
    createWorkItem({
      coordRoot: root,
      id: "create-root",
      title: "Create root",
      objective: "Reject unsupported governor profile keys",
      workflowPath: workflow,
    });
    process.chdir(root);

    const output = captureEmit();
    await createHarneryProgram({ emit: output.emit }).parseAsync([
      "node",
      "harn",
      "governor",
      "create",
      "create-root",
      "--id",
      "goal-cli-invalid-profile",
      "--team",
      team,
      "--allow-single-adapter",
    ]);

    expect(output.text()).toContain('unsupported key \\"timeoutMs\\"');
    expect(output.text()).toContain("allowed keys: instructions, adapter, effort, maxAttempts");
  });
});
