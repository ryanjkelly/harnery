#!/usr/bin/env node
/**
 * Published-package smoke test: the gate that the 0.2.0 launch lacked.
 *
 * tests/lint/typecheck/build all pass against the SOURCE under Bun, but they
 * never exercise what an end user actually gets: the built `dist/` installed
 * from a tarball, run by plain `node`, with production deps only (no dev deps).
 * Three separate startup/runtime crashes shipped to npm because nothing ran
 * `npm pack` -> install --omit=dev -> `node dist/cli.js`. This script is that
 * missing step.
 *
 * What it does:
 *   1. build dist/  (the Node target)
 *   2. npm pack      (the exact tarball npm would publish)
 *   3. install the tarball into a throwaway dir with --omit=dev
 *   4. run the CLI via `node dist/cli.js` (NOT bin/harn, which prefers Bun and
 *      would mask Node-only failures) and assert each command behaves
 *
 * Runs on Node only. Exits non-zero on the first failure with a clear message.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;

const log = (m) => process.stdout.write(`smoke: ${m}\n`);
const fail = (m) => {
  process.stderr.write(`smoke: FAIL - ${m}\n`);
  process.exit(1);
};

let workdir;
let tarball;
try {
  // 1. Build dist/
  log("building dist/ ...");
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });

  // 2. Pack the tarball npm would publish
  log("packing tarball ...");
  tarball = execFileSync("npm", ["pack"], { cwd: repoRoot, encoding: "utf8" })
    .trim()
    .split("\n")
    .pop();
  const tarballPath = join(repoRoot, tarball);
  log(`packed ${tarball}`);

  // 3. Install into a throwaway dir, production deps only
  workdir = mkdtempSync(join(tmpdir(), "harnery-smoke-"));
  writeFileSync(
    join(workdir, "package.json"),
    JSON.stringify({ name: "harnery-smoke", version: "1.0.0", private: true }, null, 2),
  );
  log("installing tarball with --omit=dev ...");
  execFileSync("npm", ["install", tarballPath, "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: workdir,
    stdio: "inherit",
  });

  const cli = join(workdir, "node_modules", "harnery", "dist", "cli.js");

  // Run `node dist/cli.js <args>` with Bun scrubbed from PATH so we exercise
  // the Node path (bin/harn would prefer Bun and mask Node-only failures).
  const nodePath = process.execPath;
  const run = (args, input) =>
    execFileSync(nodePath, [cli, ...args], {
      cwd: workdir,
      encoding: "utf8",
      input,
      env: { ...process.env, PATH: "/usr/bin:/bin" },
    });

  // 4. Assertions

  // --version: must print the real package version, not a scaffold placeholder.
  log("checking `--version` ...");
  const versionOut = run(["--version"]).trim();
  if (versionOut !== pkgVersion) {
    fail(`--version printed "${versionOut}", expected "${pkgVersion}"`);
  }
  log(`--version -> ${versionOut} OK`);

  // --help: must boot and list commands (this crashed in 0.2.0).
  log("checking `--help` boots ...");
  const helpOut = run(["--help"]);
  if (!/Usage:/.test(helpOut) || !/outline/.test(helpOut)) {
    fail("--help did not render the expected command listing");
  }
  log("--help OK");

  // Durable workflow approvals must be reachable through the packed Node CLI.
  log("checking durable workflow approval CLI boots ...");
  mkdirSync(join(workdir, ".harnery"));
  const approvalsOut = run(["workflow", "approvals", "list"]);
  if (!/no workflow approvals/.test(approvalsOut)) {
    fail("workflow approvals list did not render an empty durable inbox");
  }
  log("workflow approvals CLI OK");

  // Durable work must boot through the packed Node CLI and preserve a record.
  log("checking durable work CLI boots ...");
  const workWorkflow = join(workdir, "work-smoke.mjs");
  writeFileSync(workWorkflow, "export default async () => 'ok';\n");
  const workCreateOut = run([
    "work",
    "create",
    "Package smoke",
    workWorkflow,
    "--objective",
    "Verify the packed durable-work surface",
    "--id",
    "work-smoke",
  ]);
  if (!/work-smoke/.test(workCreateOut) || !/ready/.test(workCreateOut)) {
    fail("work create did not produce a ready durable record");
  }
  const workListOut = run(["work", "list"]);
  if (!/work-smoke/.test(workListOut) || !/Package smoke/.test(workListOut)) {
    fail("work list did not read the packed durable record");
  }
  log("durable work CLI OK");

  // A durable supervisor must freeze a team around packed durable work.
  log("checking durable supervisor CLI boots ...");
  const teamFile = join(workdir, "team.json");
  writeFileSync(
    teamFile,
    JSON.stringify({
      reviewer: { instructions: "Review the assignment carefully." },
      planner: { instructions: "Plan a bounded recovery graph." },
    }),
  );
  const replanningFile = join(workdir, "replanning.json");
  writeFileSync(
    replanningFile,
    JSON.stringify({
      planner_specialist: "planner",
      templates: {
        recovery: { workflow: "./work-smoke.mjs", max_attempts: 1, root: true },
      },
    }),
  );
  const supervisorCreateOut = run([
    "supervisor",
    "create",
    "work-smoke",
    "--team",
    teamFile,
    "--id",
    "goal-smoke",
    "--replanning",
    replanningFile,
  ]);
  if (!/goal-smoke/.test(supervisorCreateOut) || !/ready/.test(supervisorCreateOut)) {
    fail("supervisor create did not produce a ready durable goal");
  }
  const supervisorListOut = run(["supervisor", "list"]);
  if (!/goal-smoke/.test(supervisorListOut) || !/Package smoke/.test(supervisorListOut)) {
    fail("supervisor list did not read the packed durable goal");
  }
  const supervisorPlansOut = run(["supervisor", "plan", "list", "goal-smoke"]);
  if (!/no replanning attempts/.test(supervisorPlansOut)) {
    fail("supervisor plan list did not render the packed empty history");
  }
  const supervisorPlanHelp = run(["supervisor", "plan", "--help"]);
  if (!/retry/.test(supervisorPlanHelp)) {
    fail("supervisor plan help did not expose attention recovery");
  }
  const supervisorServiceOut = run(["supervisor", "service", "status"]);
  if (!/unconfigured/.test(supervisorServiceOut)) {
    fail("supervisor service status did not render its empty packed state");
  }
  const missionFile = join(workdir, "mission.json");
  writeFileSync(
    missionFile,
    JSON.stringify({
      objective: "Verify objective-first mission creation from the packed package",
      acceptance: ["The mission starts in initial planning"],
      max_milestones: 2,
    }),
  );
  const missionReplanningFile = join(workdir, "mission-replanning.json");
  writeFileSync(
    missionReplanningFile,
    JSON.stringify({
      planner_specialist: "planner",
      max_replans: 3,
      templates: {
        delivery: { workflow: "./work-smoke.mjs", max_attempts: 1, root: true },
      },
    }),
  );
  const missionCreateOut = run([
    "supervisor",
    "create",
    "--team",
    teamFile,
    "--id",
    "goal-smoke-mission",
    "--mission",
    missionFile,
    "--replanning",
    missionReplanningFile,
  ]);
  if (
    !/goal-smoke-mission/.test(missionCreateOut) ||
    !/next: plan_initial/.test(missionCreateOut)
  ) {
    fail("supervisor mission create did not produce an objective-first planning state");
  }
  log("durable supervisor CLI OK");

  // outline on PHP: works without the `typescript` dep.
  log("checking `outline` on a PHP file ...");
  const phpFile = join(workdir, "sample.php");
  writeFileSync(phpFile, "<?php\nfunction greet($n) { return $n; }\n");
  const outlineOut = run(["outline", phpFile]);
  if (!/greet/.test(outlineOut)) {
    fail("outline did not list the PHP function");
  }
  log("outline (php) OK");

  // read: HTML -> markdown on plain Node (this was the jsdom ERR_REQUIRE_ESM
  // crash, fixed by the linkedom swap).
  log("checking `read` (HTML to markdown) ...");
  const htmlFile = join(workdir, "sample.html");
  writeFileSync(
    htmlFile,
    "<html><body><article><h1>Smoke Test</h1><p>This is article body content, long enough that readability extracts it as the main page content for the conversion.</p></article></body></html>",
  );
  const readOut = run(["read", htmlFile]);
  if (!/## Smoke Test/.test(readOut) || !/article body content/.test(readOut)) {
    fail(`read did not produce the expected markdown. Got:\n${readOut}`);
  }
  log("read OK");

  // Public subpaths must resolve from the packed artifact, not just from the
  // source checkout. Keep this focused on the newest product-tier export so a
  // missing dist file or exports-map mismatch fails before publish.
  log("checking public `harnery/core/workflow` import ...");
  const workflowProbe = join(workdir, "workflow-import.mjs");
  writeFileSync(
    workflowProbe,
    [
      'import { WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION, WORKFLOW_PROOF_SCHEMA_VERSION, WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION, readWorkflowProof, runWorkflow, WorkflowRunError } from "harnery/core/workflow";',
      'if (WORKFLOW_ATTEMPT_CONTEXT_SCHEMA_VERSION !== 1) throw new Error("unexpected workflow attempt-context schema version");',
      'if (WORKFLOW_PROOF_SCHEMA_VERSION !== 1) throw new Error("unexpected workflow proof schema version");',
      'if (WORKFLOW_WORK_CONTEXT_SCHEMA_VERSION !== 1) throw new Error("unexpected workflow work-context schema version");',
      'if (typeof readWorkflowProof !== "function" || typeof runWorkflow !== "function") throw new Error("workflow functions missing");',
      'if (typeof WorkflowRunError !== "function") throw new Error("WorkflowRunError missing");',
      `const workflowPath = ${JSON.stringify(join(workdir, "work-context-probe.mjs"))};`,
      'const fs = await import("node:fs");',
      'fs.writeFileSync(workflowPath, "export default async ({ work }) => ({ work, frozen: Object.isFrozen(work), acceptanceFrozen: Object.isFrozen(work.acceptance) });\\n");',
      'const report = await runWorkflow(workflowPath, { coordRoot: process.cwd(), spawners: {}, workItemId: "smoke", workContext: { schema_version: 1, id: "smoke", title: "Package smoke", objective: "Verify packaged work context", acceptance: ["The public contract is available"] }, onLog: () => {} });',
      'if (report.result.work.id !== "smoke" || !report.result.frozen || !report.result.acceptanceFrozen) throw new Error("workflow work context invalid");',
      "const proof = readWorkflowProof(process.cwd(), report.runId);",
      'if (proof.run.work_context?.objective !== "Verify packaged work context") throw new Error("workflow proof lost work context");',
      'const durable = await import("harnery/core/workflow");',
      'for (const name of ["createWorkflowApproval", "resolveWorkflowApproval", "readWorkflowApproval", "acquireWorkflowResumeLease"]) {',
      '  if (typeof durable[name] !== "function") throw new Error(name + " missing");',
      "}",
    ].join("\n"),
  );
  execFileSync(nodePath, [workflowProbe], {
    cwd: workdir,
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  log("harnery/core/workflow import OK");

  log("checking public `harnery/core/work` import ...");
  const workProbe = join(workdir, "work-import.mjs");
  writeFileSync(
    workProbe,
    [
      'import { WORK_INTENT_SCHEMA_VERSION, createWorkItem, readWorkItem, reconcileWorkItem, runWorkItem } from "harnery/core/work";',
      'if (WORK_INTENT_SCHEMA_VERSION !== 1) throw new Error("unexpected work schema version");',
      "for (const fn of [createWorkItem, readWorkItem, reconcileWorkItem, runWorkItem]) {",
      '  if (typeof fn !== "function") throw new Error("work function missing");',
      "}",
      'const fs = await import("node:fs");',
      `const retryWorkflow = ${JSON.stringify(join(workdir, "retry-probe.mjs"))};`,
      'fs.writeFileSync(retryWorkflow, `export const meta = { name: "retry-probe", acceptance: [{ id: "done", statement: "Correction is verified" }] }; export default async (ctx) => { if (ctx.attempt.trigger === "retry") ctx.evidence({ kind: "review", status: "passed", label: "corrected", acceptanceIds: ["done"] }); return { work: ctx.work, attempt: ctx.attempt, frozen: Object.isFrozen(ctx.attempt), priorFrozen: !ctx.attempt.prior || Object.isFrozen(ctx.attempt.prior) }; };\\n`);',
      'createWorkItem({ coordRoot: process.cwd(), id: "retry-smoke", title: "Retry smoke", objective: "Verify packaged retry context", acceptance: ["Correction is verified"], workflowPath: retryWorkflow, maxAttempts: 2 });',
      'const first = await runWorkItem({ coordRoot: process.cwd(), workId: "retry-smoke", engine: { spawners: {}, onLog: () => {} } });',
      'if (first.result.attempt.trigger !== "initial" || readWorkItem(process.cwd(), "retry-smoke").projection.state !== "blocked") throw new Error("initial attempt context invalid");',
      'const second = await runWorkItem({ coordRoot: process.cwd(), workId: "retry-smoke", retry: true, engine: { spawners: {}, onLog: () => {} } });',
      'if (second.result.work.id !== "retry-smoke" || second.result.attempt.trigger !== "retry" || second.result.attempt.prior.run_id !== first.runId || second.result.attempt.prior.causes.join(",") !== "acceptance_unknown" || !second.result.frozen || !second.result.priorFrozen) throw new Error("retry attempt context invalid");',
      'const retryProof = JSON.parse(fs.readFileSync(second.proofPath, "utf8"));',
      'if (retryProof.run.attempt_context.prior.run_id !== first.runId) throw new Error("retry proof lost attempt context");',
      'const readonly = await import("harnery/core/work/state");',
      'if (typeof readonly.readWorkItem !== "function" || "runWorkItem" in readonly) throw new Error("read-only work state export invalid");',
    ].join("\n"),
  );
  execFileSync(nodePath, [workProbe], {
    cwd: workdir,
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  log("harnery/core/work import OK");

  log("checking public `harnery/core/supervisor` import ...");
  const supervisorProbe = join(workdir, "supervisor-import.mjs");
  writeFileSync(
    supervisorProbe,
    [
      'import { SUPERVISOR_INTENT_SCHEMA_VERSION, SUPERVISOR_PLAN_SCHEMA_VERSION, SUPERVISOR_SERVICE_CONFIG_SCHEMA_VERSION, approveSupervisorPlan, configureSupervisorService, createSupervisor, readSupervisor, readSupervisorPlans, rejectSupervisorPlan, retrySupervisorPlan, runSupervisor, runSupervisorServiceSweep } from "harnery/core/supervisor";',
      'if (SUPERVISOR_INTENT_SCHEMA_VERSION !== 1) throw new Error("unexpected supervisor schema version");',
      'if (SUPERVISOR_PLAN_SCHEMA_VERSION !== 1) throw new Error("unexpected supervisor plan schema version");',
      'if (SUPERVISOR_SERVICE_CONFIG_SCHEMA_VERSION !== 1) throw new Error("unexpected supervisor service schema version");',
      "for (const fn of [approveSupervisorPlan, configureSupervisorService, createSupervisor, readSupervisor, readSupervisorPlans, rejectSupervisorPlan, retrySupervisorPlan, runSupervisor, runSupervisorServiceSweep]) {",
      '  if (typeof fn !== "function") throw new Error("supervisor function missing");',
      "}",
      'const readonly = await import("harnery/core/supervisor/state");',
      'if (typeof readonly.readSupervisor !== "function" || typeof readonly.readSupervisorServiceStatus !== "function") throw new Error("read-only supervisor state export missing");',
      'if (typeof readonly.readSupervisorPlanReviewReceipt !== "function" || readonly.MAX_SUPERVISOR_PLAN_REVIEWERS !== 5) throw new Error("read-only supervisor review export missing");',
      'for (const forbidden of ["approveSupervisorPlan", "rejectSupervisorPlan", "retrySupervisorPlan", "runSupervisor", "runSupervisorServiceDaemon", "spawnSupervisorService"]) {',
      '  if (forbidden in readonly) throw new Error("read-only supervisor state export gained execution: " + forbidden);',
      "}",
      'const plans = await import("harnery/core/supervisor/plans");',
      'if (typeof plans.readSupervisorPlanReviewReceipt !== "function") throw new Error("supervisor plans export missing");',
    ].join("\n"),
  );
  execFileSync(nodePath, [supervisorProbe], {
    cwd: workdir,
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  log("harnery/core/supervisor import OK");

  log("checking public `harnery/core/policy` import ...");
  const policyProbe = join(workdir, "policy-import.mjs");
  writeFileSync(
    policyProbe,
    [
      'import { POLICY_SCHEMA_VERSION, evaluatePolicy, normalizePolicy, policyDigest } from "harnery/core/policy";',
      'if (POLICY_SCHEMA_VERSION !== 1) throw new Error("unexpected policy schema version");',
      'const policy = normalizePolicy({ network: "allow" });',
      'const decision = evaluatePolicy(policy, { phase: "dispatch", action: "smoke", isolation: "shared", network_access: "disabled" });',
      'if (decision.verdict !== "allow" || policyDigest(policy).length !== 64) throw new Error("policy functions invalid");',
    ].join("\n"),
  );
  execFileSync(nodePath, [policyProbe], {
    cwd: workdir,
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" },
  });
  log("harnery/core/policy import OK");

  log("ALL CHECKS PASSED");
} finally {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
  if (tarball) rmSync(join(repoRoot, tarball), { force: true });
}
