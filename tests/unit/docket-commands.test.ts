import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerApprovalCommand } from "../../src/commands/approval.ts";
import { registerDecisionCommand } from "../../src/commands/decision.ts";
import { publishDocket } from "../../src/core/presence/docket.ts";
import { fetchPresence } from "../../src/core/presence/index.ts";
import { createWorkflowApproval } from "../../src/core/run/approvals.ts";
import { fileDecision } from "../../src/lib/decision/index.ts";
import { removeDir } from "../helpers/remove-dir.ts";

/**
 * The read side of the shared docket (ADR 0255) through the real commands:
 * machine A files and shares; machine B lists, shows, searches, and is told
 * where to go when it tries to change A's items. Temp bare origin only.
 */

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

interface Captured {
  data: unknown;
  text: string[];
}

async function run(args: string[]): Promise<Captured> {
  const out: Captured = { data: undefined, text: [] };
  const emit = {
    text: (v: string) => out.text.push(v),
    data: (v: unknown) => {
      out.data = v;
    },
    config: () => {},
    error: (e: { code: string; message: string }) => {
      throw new Error(`${e.code}: ${e.message}`);
    },
  };
  const program = new Command();
  program.exitOverride();
  registerDecisionCommand(program, emit as never);
  registerApprovalCommand(program, emit as never);
  await program.parseAsync(["node", "harn", ...args]);
  return out;
}

let base: string;
let cloneA: string;
let cloneB: string;
let decisionId: string;
let approvalId: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "harnery-docket-cmd-"));
  const origin = join(base, "origin.git");
  cloneA = join(base, "a");
  cloneB = join(base, "b");
  spawnSync("git", ["init", "--bare", origin], { encoding: "utf8" });
  for (const c of [cloneA, cloneB]) {
    spawnSync("git", ["init", c], { encoding: "utf8" });
    git(c, "remote", "add", "origin", origin);
    mkdirSync(join(c, ".harnery"), { recursive: true });
  }
  for (const k of [
    "HARNERY_MACHINE",
    "HARNERY_PRESENCE",
    "HARNERY_DOCKET_SHARE",
    "HARNERY_COORD_ROOT_OVERRIDE",
    "HARNERY_BIN",
  ]) {
    saved[k] = process.env[k];
  }
  process.env.HARNERY_PRESENCE = "1";
  process.env.HARNERY_BIN = "harn";
  delete process.env.HARNERY_DOCKET_SHARE;

  process.env.HARNERY_MACHINE = "machine-a";
  writeFileSync(join(cloneA, ".harnery", "config.jsonc"), '{ "decision": { "share": true } }\n');
  const filed = fileDecision(cloneA, {
    question: "Should the nightly export move to a queue?",
    tier: 2,
    stakes: "medium",
    filedBy: "agent-Filer",
    brief: "Two options are on the table.",
  });
  decisionId = filed.manifest!.decision_id;
  approvalId = createWorkflowApproval({
    coordRoot: cloneA,
    runId: "run-remote",
    decisionId: "p1",
    policy: { name: "p", sha256: "c".repeat(64) },
    request: {
      phase: "dispatch",
      action: "spawn helper",
      isolation: "shared",
      network_access: "unknown",
    } as never,
    evaluation: {
      verdict: "ask",
      reason: "ask a person",
      rules: [{ code: "r", verdict: "ask", reason: "ask a person" }],
    } as never,
  }).approval.request.id;
  expect(publishDocket(cloneA, { sync: true }).status).toBe("published");

  process.env.HARNERY_MACHINE = "machine-b";
  process.env.HARNERY_COORD_ROOT_OVERRIDE = cloneB;
  fetchPresence(cloneB, { force: true, sync: true });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeDir(base);
});

describe("decision commands read other machines' shared dockets", () => {
  test("list hides remote rows unless --remote; rows are labelled read-only", async () => {
    const local = (await run(["decision", "list"])).data as { rows: unknown[] };
    expect(local.rows).toHaveLength(0);
    const remote = (await run(["decision", "list", "--remote", "--waiting"])).data as {
      rows: Array<Record<string, unknown>>;
      meta: { remote: Array<Record<string, unknown>> };
    };
    expect(remote.rows).toHaveLength(1);
    expect(remote.rows[0]).toMatchObject({ decision_id: decisionId });
    expect(remote.rows[0]!.remote).toMatchObject({
      machine: "machine-a",
      read_only: true,
      reach: 'harn agents ping agent-Filer "<message>"',
    });
    expect(remote.meta.remote[0]).toMatchObject({ machine: "machine-a", stale: false });
  });

  test("show and search fall back to the remote copy", async () => {
    const shown = (await run(["decision", "show", decisionId])).data as Record<string, unknown>;
    expect(shown.remote).toMatchObject({ machine: "machine-a", read_only: true });
    expect(shown.bodies).toEqual([{ name: "brief.md", content: "Two options are on the table." }]);
    const found = (await run(["decision", "search", "nightly", "export"])).data as {
      rows: Array<Record<string, unknown>>;
    };
    expect(found.rows.map((r) => r.decision_id)).toEqual([decisionId]);
  });

  test("changing a remote decision is refused with where it lives", async () => {
    await expect(
      run([
        "decision",
        "resolve",
        decisionId,
        "--recommendation",
        "x",
        "--evidence",
        "y",
        "--resolved-by",
        "me",
      ]),
    ).rejects.toThrow(/remote_decision: .*machine-a.*agents ping agent-Filer/);
  });
});

describe("approval commands read other machines' shared dockets", () => {
  test("list --remote, show fallback, and refused approve", async () => {
    const listed = await run(["approval", "list", "--remote"]);
    expect(listed.text.join("")).toContain(`${approvalId}  pending`);
    expect(listed.text.join("")).toContain("[machine-a, read-only]");
    const plain = await run(["approval", "list"]);
    expect(plain.text.join("")).toBe("no workflow approvals\n");
    const shown = await run(["approval", "show", approvalId]);
    expect(shown.text.join("")).toContain("shared copy from machine-a");
    await expect(run(["approval", "approve", approvalId])).rejects.toThrow(
      /remote_approval: .*machine-a/,
    );
  });
});
