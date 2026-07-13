import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { type DevtoolName, readDevtools, type ToolStatus } from "../lib/devtools.ts";

/**
 * `devtools`: report the local state of the AI coding agents harnery supports
 * — Claude Code, Codex, and Cursor — in one place: logged-in status, plan/seat
 * tier, auth expiry, session counts, and (where the tool keeps them locally)
 * rate-limit / quota windows.
 *
 * Reads only files on disk. No network, no vendor API. Signals a tool keeps
 * server-side (Cursor usage + billing, Claude's live rate-limit windows) show
 * as blank with a note rather than a fabricated value. `--usage` adds an
 * opt-in windowed scan of local transcripts for approximate token totals.
 */

const VALID: readonly DevtoolName[] = ["claude-code", "codex", "cursor"];

interface DevtoolsOpts {
  format: string;
  usage?: boolean;
  windowDays: number;
  tool?: string[];
}

export function registerDevtoolsCommand(program: Command, emit: EmitContext): void {
  program
    .command("devtools")
    .description("Local status of the AI coding agents (Claude Code, Codex, Cursor)")
    .option(
      "--tool <name>",
      "Restrict to a tool (repeatable): claude-code | codex | cursor",
      collect,
      [],
    )
    .option("--usage", "Also scan local transcripts for approximate token totals (slower)")
    .option(
      "--window-days <n>",
      "With --usage: only count transcripts modified within N days",
      (v) => Number.parseInt(v, 10),
      7,
    )
    .option("--format <type>", "Output format: table, json", "table")
    .action((opts: DevtoolsOpts) => {
      const only = (opts.tool ?? []).filter((t): t is DevtoolName =>
        VALID.includes(t as DevtoolName),
      );
      const bad = (opts.tool ?? []).filter((t) => !VALID.includes(t as DevtoolName));
      if (bad.length) {
        emit.error({
          code: "bad_tool",
          message: `unknown --tool: ${bad.join(", ")}`,
          hint: `valid: ${VALID.join(", ")}`,
        });
        return;
      }

      const report = readDevtools({
        usage: opts.usage,
        windowDays: opts.windowDays,
        only: only.length ? only : undefined,
      });

      if (opts.format === "json") {
        emit.config({ format: "json" });
        emit.data({ ok: true, ...report });
        return;
      }

      emit.text(renderTable(report.tools, report.windowDays));
    });
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function renderTable(tools: ToolStatus[], windowDays: number | null): string {
  const lines: string[] = [];
  for (const t of tools) {
    lines.push(`── ${t.tool} ${"─".repeat(Math.max(0, 40 - t.tool.length))}`);
    if (!t.installed) {
      lines.push("   not installed");
      lines.push("");
      continue;
    }
    lines.push(`   logged in    ${fmtBool(t.loggedIn)}`);
    if (t.account) lines.push(`   account      ${t.account}`);
    if (t.plan) lines.push(`   plan         ${t.plan}`);
    if (t.rateLimitTier) lines.push(`   rate tier    ${t.rateLimitTier}`);
    if (t.authExpiresAt) lines.push(`   auth expires ${fmtDate(t.authExpiresAt)}`);
    if (t.sessions != null) lines.push(`   sessions     ${t.sessions}`);
    if (t.lastActivity) lines.push(`   last active  ${fmtDate(t.lastActivity)}`);
    if (t.quota?.length) {
      for (const q of t.quota) {
        const pct = q.usedPercent != null ? `${q.usedPercent}% used` : "usage unknown";
        const reset = q.resetsAt ? `resets ${fmtDate(q.resetsAt)}` : "";
        lines.push(`   quota (${q.window})   ${pct}${reset ? ` · ${reset}` : ""}`);
      }
    }
    if (t.tokensUsed != null) {
      const w = windowDays != null ? ` (last ${windowDays}d)` : "";
      lines.push(`   tokens${w}  ${t.tokensUsed.toLocaleString()}`);
    }
    for (const n of t.notes) lines.push(`   · ${n}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function fmtBool(v: boolean | null): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  return "unknown";
}

function fmtDate(iso: string): string {
  // Keep the machine-readable ISO but drop milliseconds for readability.
  return iso.replace(/\.\d{3}Z$/, "Z");
}
