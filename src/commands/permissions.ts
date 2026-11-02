import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveCoordRoot } from "../core/agents/coord-client.ts";
import { resolveBinName } from "../core/config.ts";
import {
  collectPermissions,
  type LiveApproval,
  type PermissionsReport,
} from "../core/permissions/index.ts";
import { readGrants } from "../lib/computer/grants.ts";
import { detectHost } from "../lib/computer/host.ts";
import { leaseDir } from "../lib/computer/lease.ts";

/** Every live desktop-control approval on this computer, for any agent or project. */
export function liveDesktopApprovals(nowMs: number = Date.now()): LiveApproval[] {
  const host = detectHost();
  if (host.kind === "unsupported" || !host.desktopStateDir) return [];
  return readGrants(leaseDir(host.desktopStateDir))
    .filter((g) => Date.parse(g.expires_at) > nowMs)
    .map((g) => ({
      agent: g.owner_label,
      ...(g.project ? { project: g.project } : {}),
      kind: g.kind,
      purpose: g.purpose,
      grantedAt: g.granted_at,
      expiresAt: g.expires_at,
    }));
}

function list(rules: Array<{ rule: string; source: string }>): string {
  return rules.length ? rules.map((r) => `${r.rule} (${r.source})`).join(", ") : "none";
}

export function renderPermissionsText(report: PermissionsReport, bin: string): string {
  const { claude, codex, cursor } = report;
  const lines = [
    `Permissions for ${report.projectRoot}`,
    "",
    "Claude Code",
    `  mode: ${claude.effective.defaultMode} (from ${claude.effective.defaultModeSource})`,
    `  allowed without asking: ${list(claude.effective.allow)}`,
    `  always asks: ${list(claude.effective.ask)}`,
    `  never allowed: ${list(claude.effective.deny)}`,
    "",
    "Codex",
    codex.available
      ? `  approval policy: ${codex.approvalPolicy ?? "Codex default"} · sandbox: ${codex.sandboxMode ?? "Codex default"} · project: ${codex.projectTrust ?? "not trusted"}`
      : `  not read: ${codex.error ?? "unavailable"}`,
    ...(codex.available
      ? [
          `  hooks: ${codex.hooks.length} (${
            Object.entries(
              codex.hooks.reduce<Record<string, number>>((acc, h) => {
                acc[h.trust] = (acc[h.trust] ?? 0) + 1;
                return acc;
              }, {}),
            )
              .map(([trust, n]) => `${n} ${trust}`)
              .join(", ") || "none"
          })`,
        ]
      : []),
    "",
    "Cursor",
    `  approval mode: ${cursor.effective.approvalMode ?? "Cursor default"} · sandbox: ${cursor.effective.sandboxMode ?? "Cursor default"}`,
    `  allowed: ${list(cursor.effective.allow)}`,
    `  denied: ${list(cursor.effective.deny)}`,
    "",
    "Desktop control approvals on this computer",
    ...(report.desktopApprovals.length
      ? report.desktopApprovals.map(
          (a) =>
            `  agent-${a.agent}: ${a.purpose} (until ${new Date(a.expiresAt).toLocaleString()})`,
        )
      : ["  none"]),
    "",
    `Computer-use mode and drivers: \`${bin} computer status\`. The dashboard shows all of this at /permissions.`,
  ];
  return lines.join("\n");
}

export function registerPermissionsCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  program
    .command("permissions")
    .description(
      "Show what the coding agents on this computer may do: Claude Code, Codex and Cursor permission settings and live desktop-control approvals (read-only)",
    )
    .option("--json", "Emit the full report as JSON")
    .option(
      "--no-codex",
      "Skip asking Codex (it starts `codex app-server`, which takes a few seconds)",
    )
    .action(async (options: { json?: boolean; codex?: boolean }) => {
      try {
        const root = context?.resolveCoordRoot?.() ?? context?.repoRoot ?? resolveCoordRoot();
        if (!root) throw new Error("not inside a Harnery project");
        const report = await collectPermissions(root, {
          codex: options.codex !== false,
          approvals: () => {
            try {
              return liveDesktopApprovals();
            } catch {
              return [];
            }
          },
        });
        if (options.json) emit.data(report);
        else emit.text(renderPermissionsText(report, resolveBinName(root)));
      } catch (error) {
        emit.error({
          code: "permissions_error",
          message: error instanceof Error ? error.message : String(error),
        });
        emit.setExitCode(1);
      }
    });
}
