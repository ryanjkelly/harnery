import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { monorepoRoot, resolveOwner } from "../core/agents/index.ts";
import { readLiveCoordinationRow } from "../core/agents/state/live-coordination-view.ts";
import {
  type ArtifactActor,
  type ArtifactDeliveryManifest,
  adoptUnmanagedArtifactFiles,
  artifactCapabilities,
  artifactsRoot,
  cleanArtifacts,
  createArtifact,
  holdArtifact,
  inventoryArtifacts,
  migrateArtifacts,
  parseArtifactDeliverySpec,
  readArtifactDeliveryManifest,
  releaseArtifact,
  renderArtifactDeliveryCard,
  renewArtifact,
  showArtifact,
  unholdArtifact,
  writeArtifactDeliveryManifest,
} from "../core/artifacts/index.ts";
import {
  artifactDefaultRetentionDays,
  coordFreshnessSeconds,
  reviewPackAutoCleanEnabled,
} from "../core/config.ts";
import { deleteExpiredPacks } from "../lib/browser/page-review-pack.ts";

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
    .option("--big", "Acknowledge that this workspace may exceed the per-bundle size ceiling")
    .option("--hold <id>", "Create the workspace with this hold already present")
    .option("--hold-reason <text>", "Why the initial hold is required")
    .option("--actor <instance-id>", "Stable owner identity for the initial hold")
    .action(
      (
        slug: string,
        opts: {
          purpose: string;
          days?: string;
          big?: boolean;
          hold?: string;
          holdReason?: string;
          actor?: string;
        },
      ) => {
        run(emit, () => {
          const repoRoot = requireRepoRoot(context);
          const actor = opts.actor ? { instance_id: opts.actor } : currentActor(repoRoot);
          if (!!opts.hold !== !!opts.holdReason)
            throw new Error("--hold and --hold-reason must be used together");
          const retentionDays = opts.days
            ? parseDays(opts.days)
            : artifactDefaultRetentionDays(repoRoot);
          const created = createArtifact(repoRoot, {
            slug,
            purpose: opts.purpose,
            retentionDays,
            actor,
            big: opts.big,
            holds: opts.hold ? [{ id: opts.hold, reason: opts.holdReason! }] : [],
          });
          emit.data({
            path: created.path,
            artifact_id: created.manifest.artifact_id,
            expires_at: created.manifest.retention.expires_at,
            owner_instance_id: actor?.instance_id ?? null,
            holds: created.manifest.holds,
          });
        });
      },
    );

  root
    .command("adopt-unmanaged")
    .description("Preview loose direct-child files, or move them into one managed workspace.")
    .option(
      "--purpose <text>",
      "Why the adopted files are being retained",
      "Adopt legacy loose artifact files",
    )
    .option("--days <n>", "Retention in days (default from artifacts.default_retention_days)")
    .option("--big", "Acknowledge an adopted bundle above the per-bundle size ceiling")
    .option("--yes", "Move the exact previewed regular files into a managed workspace")
    .action((opts: { purpose: string; days?: string; big?: boolean; yes?: boolean }) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        emit.data(
          adoptUnmanagedArtifactFiles(repoRoot, {
            yes: opts.yes,
            big: opts.big,
            purpose: opts.purpose,
            retentionDays: opts.days
              ? parseDays(opts.days)
              : artifactDefaultRetentionDays(repoRoot),
            actor: currentActor(repoRoot),
          }),
        );
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
    .command("delivery-card <ref>")
    .description("Save or render a reproducible Markdown delivery card for one artifact.")
    .option("--title <text>", "Card heading")
    .option("--url <label=url>", "Add a web destination; repeatable", collect, [])
    .option(
      "--path <label=path>",
      "Add an artifact-relative file or directory; repeatable",
      collect,
      [],
    )
    .action((ref: string, opts: { title?: string; url: string[]; path: string[] }) => {
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        const suppliedItems = [
          ...opts.url.map((spec) => parseArtifactDeliverySpec("url", spec)),
          ...opts.path.map((spec) => parseArtifactDeliverySpec("path", spec)),
        ];
        let manifest: ArtifactDeliveryManifest;
        if (suppliedItems.length > 0) {
          manifest = writeArtifactDeliveryManifest(repoRoot, ref, {
            title: opts.title ?? "Delivery",
            items: suppliedItems,
          });
        } else {
          manifest = readArtifactDeliveryManifest(repoRoot, ref);
          if (opts.title !== undefined) {
            manifest = writeArtifactDeliveryManifest(repoRoot, ref, {
              title: opts.title,
              items: manifest.items,
            });
          }
        }
        emit.text(renderArtifactDeliveryCard(repoRoot, ref, manifest).markdown);
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
          actor: currentActor(repoRoot),
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
        emit.data(releaseArtifact(repoRoot, ref, { actor: currentActor(repoRoot) }));
      });
    });

  root
    .command("capabilities")
    .description("Report artifact schema and hold capabilities for embedding clients.")
    .option("--json", "Emit the capability document as JSON")
    .action(() => emit.data(artifactCapabilities()));

  root
    .command("migrate")
    .description("Preview the explicit v1 to v2 manifest migration, preserving preimages.")
    .option("--yes", "Apply the migration to valid v1 manifests")
    .action((opts: { yes?: boolean }) =>
      run(emit, () => emit.data({ rows: migrateArtifacts(requireRepoRoot(context), opts) })),
    );

  root
    .command("hold <ref>")
    .description("Protect an artifact from cleanup until its owner removes this exact hold.")
    .requiredOption("--id <id>", "Unique hold id within this artifact")
    .requiredOption("--reason <text>", "Why cleanup must retain these files")
    .option("--actor <instance-id>", "Stable hold owner; defaults to the current agent")
    .action((ref: string, opts: { id: string; reason: string; actor?: string }) =>
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        emit.data(
          holdArtifact(repoRoot, ref, {
            id: opts.id,
            reason: opts.reason,
            actor: requireHoldActor(repoRoot, opts.actor),
          }),
        );
      }),
    );

  root
    .command("unhold <ref>")
    .description("Remove one exact hold belonging to the supplied owner.")
    .requiredOption("--id <id>", "Exact hold id to remove")
    .option("--actor <instance-id>", "Stable hold owner; defaults to the current agent")
    .action((ref: string, opts: { id: string; actor?: string }) =>
      run(emit, () => {
        const repoRoot = requireRepoRoot(context);
        emit.data(
          unholdArtifact(repoRoot, ref, opts.id, { actor: requireHoldActor(repoRoot, opts.actor) }),
        );
      }),
    );

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
        const reviewPacks = reviewPackAutoCleanEnabled(repoRoot)
          ? deleteExpiredPacks({ roots: [artifactsRoot(repoRoot)], dryRun: !opts.yes })
          : undefined;
        emit.data({
          rows,
          meta: summarize(rows),
          ...(reviewPacks ? { review_packs: reviewPacks } : {}),
        });
      });
    });
}

function requireHoldActor(repoRoot: string, explicit?: string): ArtifactActor {
  const actor = explicit ? { instance_id: explicit } : currentActor(repoRoot);
  if (!actor) throw new Error("hold operations require --actor or a current agent identity");
  return actor;
}

function currentActor(repoRoot: string): ArtifactActor | undefined {
  const instanceId = resolveOwner();
  if (!instanceId) return undefined;
  const hb = readLiveCoordinationRow(repoRoot, instanceId);
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
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 3650) {
    throw new Error("--days must be between 1 and 3650");
  }
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function summarize(
  rows: { classification: string; action: string; bytes?: number | null }[],
): Record<string, unknown> {
  const classifications: Record<string, number> = {};
  for (const row of rows) {
    classifications[row.classification] = (classifications[row.classification] ?? 0) + 1;
  }
  return {
    total: rows.length,
    bytes: rows.reduce((sum, row) => sum + (row.bytes ?? 0), 0),
    classifications,
    would_delete: rows.filter((row) => row.action === "would-delete").length,
    deleted: rows.filter((row) => row.action === "deleted").length,
    would_delete_bytes: rows.reduce(
      (sum, row) => sum + (row.action === "would-delete" ? (row.bytes ?? 0) : 0),
      0,
    ),
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
