/**
 * Managed output workspaces for page-QA commands.
 *
 * An implicit qa-run/qa-record output is working evidence, not project source.
 * Keep it in the bounded artifact store. Callers that pass --out-dir retain
 * full control of that explicit destination.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HarneryProgramContext } from "../commander.ts";
import { monorepoRoot } from "./agents/index.ts";
import {
  ARTIFACT_MANIFEST,
  type ArtifactManifestV1,
  artifactsRoot,
  configuredArtifactRetentionDays,
  createArtifact,
} from "./artifacts/index.ts";

export type QaArtifactKind = "qa-run" | "qa-record" | "review-pack";

export function resolveQaRepoRoot(context?: HarneryProgramContext): string {
  return resolve(context?.repoRoot ?? monorepoRoot() ?? process.cwd());
}

export function createManagedQaOutParent(
  repoRoot: string,
  kind: QaArtifactKind,
  opts: { retentionMinutes?: number } = {},
): string {
  return createArtifact(repoRoot, {
    slug: kind,
    purpose:
      kind === "qa-run"
        ? "Page QA run evidence"
        : kind === "review-pack"
          ? "Page review pack"
          : "Hand-recorded page QA evidence",
    retentionDays: configuredArtifactRetentionDays(repoRoot),
    // A standalone review-pack workspace IS the pack, so the artifact store's
    // own expiry follows the pack's (90 minutes by default, ruled 2026-09-02).
    ...(opts.retentionMinutes !== undefined ? { retentionMinutes: opts.retentionMinutes } : {}),
  }).path;
}

/**
 * Find the newest run in a valid managed QA workspace. This keeps no-path
 * `qa-status` useful even though every implicit invocation gets an isolated
 * artifact workspace instead of sharing one root-level `.qa-run` directory.
 */
export function latestManagedQaRun(repoRoot: string): string | null {
  const root = artifactsRoot(repoRoot);
  if (!existsSync(root)) return null;

  let workspaceNames: string[];
  try {
    workspaceNames = readdirSync(root).sort();
  } catch {
    return null;
  }

  let latest: { path: string; startedAtMs: number } | null = null;
  for (const workspaceName of workspaceNames) {
    const workspace = join(root, workspaceName);
    const manifest = readQaManifest(join(workspace, ARTIFACT_MANIFEST));
    if (!manifest) continue;

    let runNames: string[];
    try {
      runNames = readdirSync(workspace)
        .filter((name) => name.startsWith("run-"))
        .sort();
    } catch {
      continue;
    }
    for (const runName of runNames) {
      const runDir = join(workspace, runName);
      const startedAtMs = readStartedAtMs(runDir);
      if (startedAtMs === null) continue;
      if (
        latest === null ||
        startedAtMs > latest.startedAtMs ||
        (startedAtMs === latest.startedAtMs && runDir > latest.path)
      ) {
        latest = { path: runDir, startedAtMs };
      }
    }
  }
  return latest?.path ?? null;
}

function readQaManifest(path: string): ArtifactManifestV1 | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ArtifactManifestV1>;
    if (value.schema_version !== 1) return null;
    if (value.slug !== "qa-run" && value.slug !== "qa-record") return null;
    if (typeof value.artifact_id !== "string" || value.artifact_id.length === 0) return null;
    if (typeof value.purpose !== "string" || value.purpose.length === 0) return null;
    if (typeof value.created_at !== "string" || Number.isNaN(Date.parse(value.created_at))) {
      return null;
    }
    if (
      !value.retention ||
      typeof value.retention.expires_at !== "string" ||
      Number.isNaN(Date.parse(value.retention.expires_at))
    ) {
      return null;
    }
    return value as ArtifactManifestV1;
  } catch {
    return null;
  }
}

function readStartedAtMs(runDir: string): number | null {
  for (const file of ["run-status.json", "page-qa-result.json"]) {
    try {
      const value = JSON.parse(readFileSync(join(runDir, file), "utf8")) as Record<string, unknown>;
      const run = value.run;
      const startedAt =
        typeof value.started_at === "string"
          ? value.started_at
          : run &&
              typeof run === "object" &&
              typeof (run as Record<string, unknown>).started_at === "string"
            ? ((run as Record<string, unknown>).started_at as string)
            : null;
      if (!startedAt) continue;
      const parsed = Date.parse(startedAt);
      if (!Number.isNaN(parsed)) return parsed;
    } catch {
      // Try the other authoritative run document.
    }
  }
  return null;
}
