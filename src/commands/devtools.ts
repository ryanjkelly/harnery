import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  type AccountUsage,
  cursorApiKeyPath,
  type DevtoolName,
  enrichFromApi,
  type ProbeResult,
  probeEndpoints,
  type QuotaWindow,
  readDevtools,
  resolveCursorApiKey,
  type ToolStatus,
} from "../lib/devtools.ts";
import { type HelperCommandDeps, registerHelpersCommand } from "./devtools-helpers.ts";

/**
 * `devtools`: report the state of the AI coding agents harnery supports —
 * Claude Code, Codex, and Cursor — in one place: every signed-in account with
 * its plan, auth expiry and live usage windows, plus session counts and token
 * totals.
 *
 * Each account's usage comes from the first source that answers (its stored
 * token, Codex's `app-server`, a CLI Proxy API server, the last local
 * snapshot); `--no-api` keeps the report to local files. When a Cursor API key
 * is configured (`devtools cursor-key set`), it also pulls Cloud Agent activity.
 */

const VALID: readonly DevtoolName[] = ["claude-code", "codex", "cursor"];

interface DevtoolsOpts {
  format: string;
  usage?: boolean;
  windowDays: number;
  tool?: string[];
  noApi?: boolean;
}

export function registerDevtoolsCommand(
  program: Command,
  emit: EmitContext,
  helperDeps: HelperCommandDeps = {},
): void {
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
    .option("--no-api", "Local files only: skip every network usage source")
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

      // Live usage per account; --no-api forces pure-local.
      if (opts.noApi !== true) await enrichFromApi(report);

      if (opts.format === "json") {
        emit.config({ format: "json" });
        emit.data({ ok: true, ...report });
        return;
      }

      emit.text(renderTable(report.tools));
    });

  registerCursorKeyCommand(cmd, emit);
  registerDoctorCommand(cmd, emit);
  registerHelpersCommand(cmd, emit, helperDeps);
}

/**
 * `devtools doctor` — one live call per usage endpoint to check the integrations
 * still work. Surfaces `auth_rejected` (our headers/token stopped being
 * accepted) and `shape_changed` (response schema drifted) distinctly from a
 * mere rate limit. Bypasses the cache; run occasionally, by hand.
 */
function registerDoctorCommand(parent: Command, emit: EmitContext): void {
  parent
    .command("doctor")
    .description("Probe each usage source once per tool to detect header/schema drift")
    .option(
      "--tool <name>",
      "Restrict to a tool (repeatable): claude-code | codex | cursor",
      collect,
      [],
    )
    .option("--format <type>", "Output format: table, json", "table")
    .action(async (opts: { tool: string[]; format: string }) => {
      const only = (opts.tool ?? []).filter((t): t is DevtoolName =>
        VALID.includes(t as DevtoolName),
      );
      const results = await probeEndpoints({ only: only.length ? only : undefined });
      if (opts.format === "json") {
        emit.config({ format: "json" });
        emit.data({
          ok: results.every(
            (r) => !["auth_rejected", "shape_changed", "unreachable"].includes(r.outcome),
          ),
          results,
        });
        return;
      }
      emit.text(renderDoctor(results));
    });
}

const DOCTOR_MARK: Record<ProbeResult["outcome"], string> = {
  ok: "✓",
  rate_limited: "~",
  no_credential: "-",
  auth_rejected: "✗",
  shape_changed: "✗",
  unreachable: "✗",
};

function renderDoctor(results: ProbeResult[]): string {
  if (!results.length) return "no probeable sources";
  const lines: string[] = [];
  for (const r of results) {
    lines.push(
      `${DOCTOR_MARK[r.outcome]} ${r.tool.padEnd(12)} ${r.source.padEnd(17)} ${r.outcome.padEnd(14)} ${r.detail}`,
    );
    lines.push(`   ${r.endpoint}${r.clientVersion ? `  (client ${r.clientVersion})` : ""}`);
  }
  lines.push("");
  lines.push(
    "✗ auth_rejected / shape_changed = the client's request contract likely changed — review the headers/parser.",
  );
  return lines.join("\n");
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
    if (!t.accounts.length && t.account) lines.push(`   account      ${t.account}`);
    if (t.sessions != null) lines.push(`   sessions     ${t.sessions}`);
    if (t.lastActivity) lines.push(`   last active  ${fmtDate(t.lastActivity)}`);
    if (t.tokensUsed != null) lines.push(`   tokens       ${t.tokensUsed.toLocaleString()}`);
    if (t.api?.ok && t.api.cloudAgents) {
      lines.push(`   cloud agents ${t.api.cloudAgents.total} (${t.api.cloudAgents.active} active)`);
    }
    if (!t.accounts.length && t.quota?.length) {
      for (const q of t.quota) lines.push(`   ${fmtQuota(q)}`);
    }
    for (const a of t.accounts) lines.push(...renderAccount(a));
    for (const n of t.notes) lines.push(`   · ${n}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** One summary line per account, then its quota/usage detail indented beneath. */
function renderAccount(a: AccountUsage): string[] {
  const who = a.email ?? a.id.replace(/^[^:]+:/, "");
  const state = a.loggedIn ? "signed in" : "signed out";
  const src = a.source
    ? `${a.source}${a.stale ? ` (stale${a.asOf ? `, as of ${fmtDate(a.asOf)}` : ""})` : ""}`
    : "no source";
  const head = [who, a.plan, a.rateLimitTier && a.rateLimitTier !== a.plan ? a.rateLimitTier : null]
    .filter(Boolean)
    .join(" · ");
  const out = [`   ▸ ${head}  [${state}; ${src}]`];
  if (a.sourceDetail) out.push(`       via ${a.sourceDetail}`);
  if (a.stores.length > 1 || !a.sourceDetail) {
    out.push(
      `       stores ${a.stores.map((s) => `${s.kind}${s.loggedIn ? "" : " (signed out)"}`).join(", ")}`,
    );
  }
  if (a.authExpiresAt) out.push(`       auth expires ${fmtDate(a.authExpiresAt)}`);
  for (const q of a.quota ?? []) out.push(`       ${fmtQuota(q)}`);
  if (a.usage) {
    const u = a.usage;
    if (u.cycleEnd) {
      const days = Math.round((Date.parse(u.cycleEnd) - Date.now()) / 86_400_000);
      out.push(`       plan resets  ${fmtDate(u.cycleEnd)} (${days}d)`);
    }
    const pct = (label: string, v: number | null) => (v != null ? `${label} ${v}%` : null);
    const bars = [
      pct("total", u.totalPercentUsed),
      pct("api", u.apiPercentUsed),
      pct("first-party", u.firstPartyPercentUsed),
    ].filter((s): s is string => s != null);
    if (bars.length) out.push(`       usage        ${bars.join(" · ")}`);
  }
  if (a.spend?.limitCents != null) {
    const label = a.spend.label.toLowerCase().padEnd(12).slice(0, 12);
    out.push(`       ${label} ${fmtUsd(a.spend.usedCents ?? 0)} / ${fmtUsd(a.spend.limitCents)}`);
  }
  if (a.credits?.balance != null && (a.credits.hasCredits || a.credits.unlimited)) {
    out.push(
      `       credits      ${a.credits.unlimited ? "unlimited" : a.credits.balance.toLocaleString()}`,
    );
  }
  for (const g of a.resets ?? []) {
    const exp = g.expiresAt ? ` · expires ${fmtDate(g.expiresAt)}` : "";
    out.push(`       reset        ${g.left}× ${g.label}${exp}`);
  }
  for (const n of a.notes) out.push(`       · ${n}`);
  return out;
}

function fmtQuota(q: QuotaWindow): string {
  const pct = q.usedPercent != null ? `${q.usedPercent}% used` : "usage unknown";
  const reset = q.resetsAt ? `resets ${fmtDate(q.resetsAt)}` : "";
  const rate = q.recent?.ratePerHour;
  const recent = rate != null ? ` · ${rate > 0 ? "+" : ""}${rate}%/h recently` : "";
  return `quota (${q.window})   ${pct}${reset ? ` · ${reset}` : ""}${recent}`;
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
