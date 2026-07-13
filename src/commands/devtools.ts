import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  cursorApiKeyPath,
  type DevtoolName,
  enrichFromApi,
  readDevtools,
  resolveCursorApiKey,
  type ToolStatus,
} from "../lib/devtools.ts";

/**
 * `devtools`: report the local state of the AI coding agents harnery supports
 * — Claude Code, Codex, and Cursor — in one place: logged-in status, plan/seat
 * tier, auth expiry, session counts, and (where the tool keeps them locally)
 * rate-limit / quota windows.
 *
 * Reads files on disk by default (no network). When a Cursor API key is
 * configured (`devtools cursor-key set`), it additionally verifies the key and
 * pulls Cloud Agent activity. `--usage` adds an opt-in windowed scan of local
 * transcripts for approximate token totals.
 */

const VALID: readonly DevtoolName[] = ["claude-code", "codex", "cursor"];

interface DevtoolsOpts {
  format: string;
  usage?: boolean;
  windowDays: number;
  tool?: string[];
  noApi?: boolean;
}

export function registerDevtoolsCommand(program: Command, emit: EmitContext): void {
  const cmd = program
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
    .option("--no-api", "Skip the Cursor API enrichment even when a key is configured")
    .option("--format <type>", "Output format: table, json", "table")
    .action(async (opts: DevtoolsOpts) => {
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

      // Auto-enrich when a Cursor key is configured (the user opted in by
      // storing one); --no-api forces pure-local.
      if (opts.noApi !== true) await enrichFromApi(report);

      if (opts.format === "json") {
        emit.config({ format: "json" });
        emit.data({ ok: true, ...report });
        return;
      }

      emit.text(renderTable(report.tools));
    });

  registerCursorKeyCommand(cmd, emit);
}

/** `devtools cursor-key set|clear|status` — store the machine-local Cursor API key. */
function registerCursorKeyCommand(parent: Command, emit: EmitContext): void {
  const key = parent
    .command("cursor-key")
    .description("Manage the Cursor API key used for the Cloud Agent enrichment");

  key
    .command("set [value]")
    .description("Store a Cursor API key (reads stdin when [value] is omitted)")
    .action(async (value: string | undefined) => {
      const raw = value ?? (await readStdin());
      const trimmed = raw.trim();
      if (!trimmed) {
        emit.error({ code: "empty_key", message: "no key provided (arg or stdin)" });
        return;
      }
      const path = cursorApiKeyPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, trimmed, { mode: 0o600 });
      chmodSync(path, 0o600);
      emit.file(path, { stored: true, length: trimmed.length });
    });

  key
    .command("clear")
    .description("Remove the stored Cursor API key")
    .action(() => {
      try {
        rmSync(cursorApiKeyPath());
      } catch {
        // already absent
      }
      emit.data({ ok: true, cleared: true });
    });

  key
    .command("status")
    .description("Report whether a Cursor key is configured (env or file)")
    .action(() => {
      const fromEnv = Boolean(process.env.CURSOR_API_KEY?.trim());
      const resolved = resolveCursorApiKey();
      emit.data({
        ok: true,
        configured: Boolean(resolved),
        source: fromEnv ? "env" : resolved ? "file" : null,
        path: cursorApiKeyPath(),
      });
    });
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", () => resolve(data));
  });
}

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

function renderTable(tools: ToolStatus[]): string {
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
      lines.push(`   tokens       ${t.tokensUsed.toLocaleString()}`);
    }
    if (t.usage) {
      const u = t.usage;
      if (u.cycleEnd) {
        const days = Math.round((Date.parse(u.cycleEnd) - Date.now()) / 86_400_000);
        lines.push(`   plan resets  ${fmtDate(u.cycleEnd)} (${days}d)`);
      }
      const pct = (label: string, v: number | null) => (v != null ? `${label} ${v}%` : null);
      const bars = [
        pct("total", u.totalPercentUsed),
        pct("api", u.apiPercentUsed),
        pct("first-party", u.firstPartyPercentUsed),
      ].filter((s): s is string => s != null);
      if (bars.length) lines.push(`   usage        ${bars.join(" · ")}`);
    }
    if (t.spend?.limitCents != null) {
      const label = t.spend.label.toLowerCase().padEnd(12).slice(0, 12);
      lines.push(`   ${label} ${fmtUsd(t.spend.usedCents ?? 0)} / ${fmtUsd(t.spend.limitCents)}`);
    }
    if (t.api?.ok && t.api.cloudAgents) {
      lines.push(`   cloud agents ${t.api.cloudAgents.total} (${t.api.cloudAgents.active} active)`);
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

/** Cents → "$X.XX". */
function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
