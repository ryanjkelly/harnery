import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveCoordRoot } from "../core/agents/coord-client.ts";
import { artifactsRoot, parseArtifactManifest } from "../core/artifacts/index.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../core/events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../core/events/v3/live-route-observer.ts";
import { resolveOwner } from "../core/hooks/resolve/owner.ts";
import { guardedRemove, type RemoveOptions } from "../lib/guarded-remove.ts";

export function registerRmCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  program
    .command("rm <paths...>")
    .description("Preview guarded removal of untracked files; --yes applies permanent deletion")
    .requiredOption(
      "--root <directory>",
      "Allowed directory; each target must be strictly inside it",
    )
    .option("-r, --recursive", "Permit directory removal after inspecting its complete contents")
    .option(
      "--clean-clone",
      "Remove only clean standalone clones inside one owned artifact; refuse local-only commits and worktrees",
    )
    .option(
      "--entry-limit <n>",
      "Maximum inspected entries, 1-100000 (default 10000); larger limits require one current caller-owned managed artifact as --root",
      (value: string) => Number(value),
    )
    .option(
      "--allow-protected <path>",
      "Remove this one protected path (Git metadata, credentials, Harnery state, keys) inside a target; repeat per path",
      (value: string, previous: string[] = []) => [...previous, value],
    )
    .option("--yes", "Permanently remove validated targets")
    .option("--dry-run", "Preview only, even with --yes")
    .option("--json", "Emit the versioned removal report")
    .action((paths: string[], options: RemoveOptions & { json?: boolean }) => {
      try {
        const coordRoot = context?.resolveCoordRoot?.() ?? context?.repoRoot ?? resolveCoordRoot();
        const checkClaims = (targets: string[]): void => {
          if (!coordRoot || !existsSync(resolve(coordRoot, ".harnery"))) return;
          const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
          const owner = resolveOwner({ payload: null, coordRoot });
          const ownId = owner ? liveInstanceIdV3(owner.instance_id) : undefined;
          const ownSession = ownId ? view.instances[ownId]?.session_id : undefined;
          for (const peer of Object.values(view.instances)) {
            if (
              !peer.authority_eligible ||
              peer.instance_id === ownId ||
              (ownSession && peer.session_id === ownSession)
            )
              continue;
            for (const claim of peer.files_touched) {
              const claimed = resolve(coordRoot, claim);
              for (const target of targets) {
                if (overlaps(target, claimed))
                  throw new Error(
                    `Target overlaps another agent's claim: ${claim} (${peer.instance_id})`,
                  );
              }
            }
          }
        };
        // The workspace this command coordinates, and the checkout it runs in:
        // their own .git and .harnery can never be allowed.
        const liveRoots = [coordRoot, gitTopLevel(process.cwd())].filter((dir): dir is string =>
          Boolean(dir),
        );
        const assertOwnedArtifact = (root: string): void => {
          if (!coordRoot || dirname(root) !== realpathSync(artifactsRoot(coordRoot)))
            throw new Error("Copied state requires --root to name one owned managed artifact");
          const view = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(coordRoot));
          const owner = resolveOwner({ payload: null, coordRoot });
          const ownId = owner ? liveInstanceIdV3(owner.instance_id) : undefined;
          if (!ownId || !view.instances[ownId]?.authority_eligible)
            throw new Error("Copied state requires an authenticated current artifact owner");
          const record = resolve(root, ".harnery-artifact.json");
          const stat = lstatSync(record);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error("An owned artifact requires a regular manifest file");
          const parsed = parseArtifactManifest(JSON.parse(readFileSync(record, "utf8")));
          if (
            !parsed.ok ||
            parsed.manifest.released_at ||
            !parsed.manifest.created_by?.instance_id ||
            liveInstanceIdV3(parsed.manifest.created_by.instance_id) !== ownId
          )
            throw new Error(
              "Copied state requires a valid unreleased artifact owned by the caller",
            );
        };
        const report = guardedRemove(
          paths,
          { ...options, liveRoots, assertOwnedArtifact },
          checkClaims,
        );
        if (options.json) {
          emit.config({ format: "json" });
          emit.data(report);
        } else {
          const lines = [
            `${report.applied ? "Removed" : "Would remove"} ${report.targets.length} target(s), ${report.entries} entries, ${report.bytes} bytes:`,
            ...report.targets,
          ];
          if (report.protected.length)
            lines.push(
              options.cleanClone
                ? "Verified clone metadata:"
                : "Protected paths named with --allow-protected:",
              ...report.protected.map((path) => `  ${path}`),
            );
          if (report.links.length)
            lines.push(
              "Links removed as links (their targets are untouched):",
              ...report.links.map((link) => `  ${link.path} -> ${link.target}`),
            );
          if (!report.applied)
            lines.push("Preview only. Add --yes to permanently delete these targets.");
          emit.text(lines.join("\n"));
        }
      } catch (error) {
        emit.error({
          code: "removal_refused",
          message: error instanceof Error ? error.message : String(error),
        });
        emit.setExitCode(1);
      }
    });
}

function gitTopLevel(dir: string): string | undefined {
  const result = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}
