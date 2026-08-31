import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { monorepoRoot, resolveOwner } from "../core/agents/index.ts";
import { readLiveCoordinationRow } from "../core/agents/state/live-coordination-view.ts";
import type { ArtifactActor } from "../core/artifacts/index.ts";
import {
  buildDiagnosticAdvice,
  captureDiagnosticBundle,
  DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
  listDiagnosticBundles,
  replayDiagnosticBundle,
  showDiagnosticBundle,
} from "../core/diagnostics/index.ts";
import {
  buildSupervisorTimeline,
  explainSupervisorFinding,
  readSupervisorExplanation,
  readSupervisorFindings,
  readSupervisorStatus,
  readSupervisorTimeline,
  type SupervisorCapability,
  type SupervisorFinding,
} from "../core/supervisor/index.ts";

export function registerDiagnosticsCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const root = program
    .command("diagnostics")
    .description("Capture, inspect, and replay sanitized local diagnostic bundles.");

  root
    .command("list")
    .description("List live findings and managed diagnostic bundles.")
    .action(() => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        const report = readSupervisorFindings(repoRoot);
        const findings = mergeFindings(report?.active ?? [], report?.transitions ?? []);
        const bundles = listDiagnosticBundles(repoRoot);
        const capability = liveFindingsCapability(repoRoot, report !== undefined);
        emit.data({
          schema_version: DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
          kind: "diagnostic_list",
          findings,
          bundles,
          capability,
          total_findings: findings.length,
          total_bundles: bundles.length,
        });
      });
    });

  root
    .command("show <ref>")
    .description("Show one finding or validate one diagnostic bundle.")
    .action((ref: string) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        const finding = findFinding(repoRoot, ref);
        if (finding) {
          emit.data({
            schema_version: DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
            kind: "diagnostic_finding",
            finding,
            timeline:
              readSupervisorTimeline(repoRoot, finding.id) ?? buildSupervisorTimeline(finding),
            explanation:
              readSupervisorExplanation(repoRoot, finding.id) ?? explainSupervisorFinding(finding),
          });
          return;
        }
        const bundle = showDiagnosticBundle(repoRoot, ref);
        emit.data({
          schema_version: DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
          kind: "diagnostic_bundle",
          bundle: {
            path: bundle.path,
            manifest: bundle.manifest,
            summary: bundle.summary,
          },
        });
      });
    });

  root
    .command("explain")
    .description("Report bounded local pressure advice without taking action.")
    .option("--bundle <artifact-ref>", "Use a frozen diagnostic bundle instead of live state")
    .option("--json", "Emit structured JSON")
    .action((opts: { bundle?: string; json?: boolean }) => {
      run(emit, () => {
        if (opts.json) emit.config({ format: "json" });
        const repoRoot = requireRepoRoot(context);
        if (opts.bundle) {
          const bundle = showDiagnosticBundle(repoRoot, opts.bundle);
          emit.data({
            schema_version: DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
            kind: "diagnostic_advice",
            source: {
              mode: "frozen",
              artifact_id: bundle.manifest.artifact_id,
              captured_at: bundle.manifest.captured_at,
            },
            advice: bundle.expected.advice,
          });
          return;
        }
        const report = readSupervisorFindings(repoRoot);
        const findings = mergeFindings(report?.active ?? [], report?.transitions ?? []);
        const sourceCapability = liveFindingsCapability(repoRoot, report !== undefined);
        emit.data({
          schema_version: DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
          kind: "diagnostic_advice",
          source: { mode: "live" },
          advice: buildDiagnosticAdvice({
            findings,
            sourceCapability,
            evaluatedAt: new Date().toISOString(),
          }),
        });
      });
    });

  root
    .command("capture")
    .description("Capture sanitized supervisor inputs into a frozen managed bundle.")
    .option("--finding <id>", "Capture the time range for one finding")
    .option("--from <timestamp>", "Capture observations from this ISO timestamp")
    .option("--to <timestamp>", "Capture observations through this ISO timestamp")
    .option("--days <n>", "Managed artifact retention in days")
    .action((opts: { finding?: string; from?: string; to?: string; days?: string }) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        const captured = captureDiagnosticBundle(repoRoot, {
          findingId: opts.finding,
          startAt: opts.from,
          endAt: opts.to,
          retentionDays: opts.days === undefined ? undefined : parseDays(opts.days),
          actor: currentActor(repoRoot),
        });
        emit.data({
          schema_version: DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
          kind: "diagnostic_bundle_capture",
          bundle: {
            path: captured.path,
            artifact_id: captured.manifest.artifact_id,
            captured_at: captured.manifest.captured_at,
            finding_id: captured.manifest.finding_id,
            summary: captured.summary,
          },
        });
      });
    });

  root
    .command("replay <artifact-ref>")
    .description("Replay a frozen bundle without reading live supervisor state.")
    .action((ref: string) => {
      run(emit, () => {
        emit.data({
          schema_version: DIAGNOSTIC_COMMAND_SCHEMA_VERSION,
          kind: "diagnostic_bundle_replay",
          replay: replayDiagnosticBundle(requireRepoRoot(context), ref),
        });
      });
    });
}

function liveFindingsCapability(repoRoot: string, reportPresent: boolean): SupervisorCapability {
  if (!reportPresent) {
    return {
      source_kind: "supervisor.findings",
      state: "unsupported",
      reason_code: "source_missing",
    };
  }
  const status = readSupervisorStatus(repoRoot);
  if (status.running) return { source_kind: "supervisor.findings", state: "supported" };
  return {
    source_kind: "supervisor.findings",
    state: "expired",
    reason_code: status.stale
      ? "supervisor_status_stale"
      : status.record
        ? "supervisor_not_running"
        : "supervisor_status_missing",
  };
}

function findFinding(repoRoot: string, id: string): SupervisorFinding | undefined {
  const report = readSupervisorFindings(repoRoot);
  return mergeFindings(report?.active ?? [], report?.transitions ?? []).find(
    (finding) => finding.id === id,
  );
}

function mergeFindings(
  active: readonly SupervisorFinding[],
  transitions: readonly SupervisorFinding[],
): SupervisorFinding[] {
  const byId = new Map<string, SupervisorFinding>();
  for (const finding of transitions) byId.set(finding.id, finding);
  for (const finding of active) byId.set(finding.id, finding);
  return [...byId.values()].sort(
    (left, right) =>
      Date.parse(right.observed_at) - Date.parse(left.observed_at) ||
      left.id.localeCompare(right.id),
  );
}

function currentActor(repoRoot: string): ArtifactActor | undefined {
  const instanceId = resolveOwner();
  if (!instanceId) return undefined;
  const heartbeat = readLiveCoordinationRow(repoRoot, instanceId);
  return {
    instance_id: instanceId,
    session_id: heartbeat?.session_id,
    name: heartbeat?.name,
  };
}

function requireRepoRoot(context?: HarneryProgramContext): string {
  const root = context?.repoRoot ?? monorepoRoot();
  if (!root) throw new Error("not inside a Git repository");
  return root;
}

function parseDays(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3_650) {
    throw new Error("--days must be between 1 and 3650");
  }
  return parsed;
}

function run(emit: EmitContext, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    emit.error({
      code: "diagnostics_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    emit.setExitCode(1);
  }
}
