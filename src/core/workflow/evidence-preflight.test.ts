import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWorkflow } from "./engine.ts";
import { evidencePreflightError, findInvalidEvidenceKinds } from "./evidence-preflight.ts";
import type { Spawner } from "./types.ts";

describe("findInvalidEvidenceKinds", () => {
  test("accepts every kind in the vocabulary", () => {
    const source = `
      export default async ({ evidence }) => {
        evidence({ kind: "test", status: "passed", label: "unit" });
        evidence({ kind: "command", status: "passed", label: "build" });
        evidence({ kind: "artifact", status: "observed", label: "bundle" });
        evidence({ kind: "change", status: "passed", label: "diff" });
        evidence({ kind: "review", status: "passed", label: "read" });
        evidence({ kind: "observation", status: "observed", label: "note" });
      };
    `;
    expect(findInvalidEvidenceKinds(source)).toEqual([]);
  });

  test("catches the kind that killed a finished run, with its line", () => {
    // The measured failure: a fifty-minute run died at its final line.
    const source = [
      "export default async ({ evidence }) => {",
      '  evidence({ kind: "design" });',
      "};",
    ].join("\n");
    expect(findInvalidEvidenceKinds(source)).toEqual([{ kind: "design", line: 2 }]);
  });

  test("reads a kind through a dotted receiver and single quotes", () => {
    const source = "export default async (ctx) => { ctx.evidence({ kind: 'proof' }); };";
    expect(findInvalidEvidenceKinds(source)).toEqual([{ kind: "proof", line: 1 }]);
  });

  test("says nothing about a computed kind, leaving runtime validation to it", () => {
    const dynamic = [
      "export default async ({ evidence }) => {",
      "  const k = pick();",
      "  evidence({ kind: k });",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is fixture source, and the placeholder is the dynamic case under test.
      "  evidence({ kind: `${prefix}-thing` });",
      "};",
    ].join("\n");
    expect(findInvalidEvidenceKinds(dynamic)).toEqual([]);
  });

  test("ignores a kind property that is not an evidence argument", () => {
    const source = `
      const item = { source: { kind: "human" } };
      export default async ({ evidence }) => {
        const spec = { kind: "delivery", template: "x" };
        evidence({ kind: "review", status: "passed", label: String(spec.kind) });
      };
    `;
    expect(findInvalidEvidenceKinds(source)).toEqual([]);
  });

  test("ignores commented-out and quoted evidence calls", () => {
    const source = [
      "export default async ({ evidence }) => {",
      '  // evidence({ kind: "design" });',
      '  /* evidence({ kind: "sketch" }); */',
      '  const help = "evidence({ kind: \\"plan\\" })";',
      '  evidence({ kind: "test", status: "passed", label: "unit" });',
      "};",
    ].join("\n");
    expect(findInvalidEvidenceKinds(source)).toEqual([]);
  });

  test("a brace or paren inside a string cannot desynchronise the scan", () => {
    const source = [
      "export default async ({ evidence }) => {",
      '  evidence({ kind: "review", status: "passed", label: "a) weird ( label {" });',
      '  evidence({ kind: "design" });',
      "};",
    ].join("\n");
    expect(findInvalidEvidenceKinds(source)).toEqual([{ kind: "design", line: 3 }]);
  });

  test("reports every offender, not just the first", () => {
    const source = [
      "export default async ({ evidence }) => {",
      '  evidence({ kind: "design" });',
      '  evidence({ kind: "test", status: "passed", label: "unit" });',
      '  evidence({ kind: "sketch" });',
      "};",
    ].join("\n");
    expect(findInvalidEvidenceKinds(source).map((p) => p.kind)).toEqual(["design", "sketch"]);
  });

  test("an unterminated string does not swallow the rest of the file", () => {
    const source = ['const broken = "oops;', 'evidence({ kind: "design" });'].join("\n");
    expect(() => findInvalidEvidenceKinds(source)).not.toThrow();
  });
});

describe("evidencePreflightError", () => {
  test("is silent on a clean script", () => {
    const source = 'export default async ({ evidence }) => evidence({ kind: "test" });';
    expect(evidencePreflightError(source, "ok.mjs")).toBeUndefined();
  });

  test("names the script, the offending kinds, and why it refused early", () => {
    const source = 'export default async ({ evidence }) => evidence({ kind: "design" });';
    const message = evidencePreflightError(source, "workflows/research.mjs");
    expect(message).toContain("workflows/research.mjs");
    expect(message).toContain('"design"');
    expect(message).toContain("test, command, artifact, change, review, observation");
    expect(message).toContain("discard the work");
  });
});

describe("the engine refuses before it spends anything", () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `workflow-preflight-${process.pid}-${Date.now()}-${Math.random()}`);
    mkdirSync(join(root, ".harnery"), { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function script(body: string): string {
    const path = join(root, "workflow.mjs");
    writeFileSync(path, body);
    return path;
  }

  test("an invalid kind stops the run before the first agent is spawned", async () => {
    let spawns = 0;
    const spawner: Spawner = async () => {
      spawns++;
      return { ok: true, text: "done", durationMs: 1 };
    };
    // The shape that cost a finished run: the agents come first, the bad kind is
    // on the last line. Nothing should reach the spawner.
    await expect(
      runWorkflow(
        script(
          [
            "export const meta = { name: 'x', acceptance: [{ id: 'done', statement: 'Done' }] };",
            "export default async ({ agent, evidence }) => {",
            "  const result = await agent('do the work');",
            "  evidence({ kind: 'design', status: 'passed', label: 'the design', acceptanceIds: ['done'] });",
            "  return result;",
            "};",
          ].join("\n"),
        ),
        {
          coordRoot: root,
          spawners: { "claude-code": spawner },
          probeBilling: () => ({
            harness: "claude-code",
            apiKeySource: null,
            apiKeyPresent: false,
            login: "present",
            mode: "subscription",
          }),
          onLog: () => {},
        },
      ),
    ).rejects.toThrow(/evidence kind must be one of/);
    expect(spawns).toBe(0);
  });

  test("a valid kind is left alone", async () => {
    const spawner: Spawner = async () => ({ ok: true, text: "done", durationMs: 1 });
    const report = await runWorkflow(
      script(
        [
          "export const meta = { name: 'x', acceptance: [{ id: 'done', statement: 'Done' }] };",
          "export default async ({ agent, evidence }) => {",
          "  const result = await agent('do the work');",
          "  evidence({ kind: 'review', status: 'passed', label: 'read it', acceptanceIds: ['done'] });",
          "  return result;",
          "};",
        ].join("\n"),
      ),
      {
        coordRoot: root,
        spawners: { "claude-code": spawner },
        probeBilling: () => ({
          harness: "claude-code",
          apiKeySource: null,
          apiKeyPresent: false,
          login: "present",
          mode: "subscription",
        }),
        onLog: () => {},
      },
    );
    expect(report.agentsSpawned).toBe(1);
    expect(report.acceptance.unsatisfied).toBe(0);
  });
});
