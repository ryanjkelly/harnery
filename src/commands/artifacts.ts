import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { monorepoRoot, readHeartbeat, resolveOwner } from "../core/agents/index.ts";
import {
  type ArtifactActor,
  cleanArtifacts,
  createArtifact,
  inventoryArtifacts,
  releaseArtifact,
  renewArtifact,
  showArtifact,
} from "../core/artifacts/index.ts";
import { artifactDefaultRetentionDays, coordFreshnessSeconds } from "../core/config.ts";

export function registerArtifactsCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const root = program
    .command("artifacts")
    .alias("artifact")
    .description("Manage repository-local working artifacts under .harnery/artifacts/");

  root
    .command("create <slug>")
    .description("Create one managed artifact workspace and print its path.")
    .requiredOption("--purpose <text>", "What the files are for")
    .option("--days <n>", "Retention in days (default from artifacts.default_retention_days)")
    .action((slug: string, opts: { purpose: string; days?: string }) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        const actor = currentActor();
        const retentionDays = opts.days
          ? parseDays(opts.days)
          : artifactDefaultRetentionDays(repoRoot);
        const created = createArtifact(repoRoot, {
          slug,
          purpose: opts.purpose,
          retentionDays,
          actor,
        });
        emit.data({
          path: created.path,
          artifact_id: created.manifest.artifact_id,
          expires_at: created.manifest.retention.expires_at,
          owner_instance_id: actor?.instance_id ?? null,
        });
      });
    });

  root
    .command("list")
    .description("Inventory every artifact workspace with its cleanup classification.")
    .action(() => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        const rows = inventoryArtifacts(repoRoot, {
          freshnessSeconds: coordFreshnessSeconds(repoRoot),
        });
        emit.data({ rows, meta: summarize(rows) });
      });
    });

  root
    .command("show <ref>")
    .description("Show one artifact by id, directory name, or direct-child path.")
    .action((ref: string) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        emit.data(
          showArtifact(repoRoot, ref, {
            freshnessSeconds: coordFreshnessSeconds(repoRoot),
          }),
        );
      });
    });

  root
    .command("renew <ref>")
    .description("Set a new retention window. Renewal does not mark the artifact active.")
    .requiredOption("--days <n>", "Days from now")
    .requiredOption("--reason <text>", "Why the extra retention is needed")
    .action((ref: string, opts: { days: string; reason: string }) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        const manifest = renewArtifact(repoRoot, ref, parseDays(opts.days), opts.reason, {
          actor: currentActor(),
        });
        emit.data(manifest);
      });
    });

  root
    .command("release <ref>")
    .description("Release active-owner protection without shortening retention.")
    .action((ref: string) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        emit.data(releaseArtifact(repoRoot, ref, { actor: currentActor() }));
      });
    });

  root
    .command("clean")
    .description("Preview expired artifact deletion; pass --yes to delete.")
    .option("--yes", "Permanently delete entries classified managed-expired")
    .action((opts: { yes?: boolean }) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        const rows = cleanArtifacts(repoRoot, {
          yes: opts.yes,
          freshnessSeconds: coordFreshnessSeconds(repoRoot),
        });
        emit.data({ rows, meta: summarize(rows) });
      });
    });
}

function currentActor(): ArtifactActor | undefined {
  const instanceId = resolveOwner();
  if (!instanceId) return undefined;
  const hb = readHeartbeat(instanceId);
  return {
    instance_id: instanceId,
    session_id: hb?.session_id,
    name: hb?.name,
  };
}

function requireRepoRoot(context?: HarneryProgramContext): string {
  const root = context?.repoRoot ?? monorepoRoot();
  if (!root) throw new Error("not inside a Git repository");
  return root;
}

function parseDays(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 3650) {
    throw new Error("--days must be between 1 and 3650");
  }
  return parsed;
}

function summarize(rows: { classification: string; action: string }[]): Record<string, unknown> {
  const classifications: Record<string, number> = {};
  for (const row of rows) {
    classifications[row.classification] = (classifications[row.classification] ?? 0) + 1;
  }
  return {
    total: rows.length,
    classifications,
    would_delete: rows.filter((row) => row.action === "would-delete").length,
    deleted: rows.filter((row) => row.action === "deleted").length,
  };
}

function run(emit: EmitContext, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    emit.error({
      code: "artifact_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    emit.setExitCode(1);
  }
}
