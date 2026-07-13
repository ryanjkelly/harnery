/**
 * Devtools read-side helper for the dashboard. Shells out to the host CLI's
 * `devtools` command (`harnery/bin/harn devtools --format json`) rather than
 * importing `src/lib/devtools.ts` directly, for one concrete reason: the Cursor
 * reader needs `bun:sqlite` to read `state.vscdb`, and the web app runs under
 * Node (`next dev`), where that engine is absent. Running the CLI executes it
 * under Bun, so the dashboard gets the same full-fidelity data as the terminal.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { coordRoot } from "./coord-reader";

export interface QuotaWindow {
  window: string;
  usedPercent: number | null;
  resetsAt: string | null;
}

export interface ApiEnrichment {
  ok: boolean;
  keyName: string | null;
  cloudAgents: { total: number; active: number } | null;
  error: string | null;
}

export interface ToolStatus {
  tool: "claude-code" | "codex" | "cursor";
  installed: boolean;
  loggedIn: boolean | null;
  account: string | null;
  plan: string | null;
  rateLimitTier: string | null;
  authExpiresAt: string | null;
  sessions: number | null;
  lastActivity: string | null;
  quota: QuotaWindow[] | null;
  tokensUsed: number | null;
  api: ApiEnrichment | null;
  notes: string[];
}

export interface DevtoolsReport {
  ok: boolean;
  generatedAt: string;
  windowDays: number | null;
  tools: ToolStatus[];
  error?: string;
}

function binPath(): string {
  // harnery/web/lib/devtools-reader.ts → coordRoot/harnery/bin/harn
  return path.join(coordRoot(), "harnery", "bin", "harn");
}

/**
 * Run `harn devtools --format json` and return the parsed report. Never throws:
 * on any failure it returns a report with `ok: false` and an `error` string so
 * the page can render a graceful empty state.
 */
export async function readDevtoolsReport(): Promise<DevtoolsReport> {
  const args = ["devtools", "--format", "json"];
  const root = coordRoot();
  return new Promise((resolve) => {
    const proc = spawn(binPath(), args, {
      cwd: root,
      env: { ...process.env, HARNERY_COORD_ROOT_OVERRIDE: root },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => {
      stdout += c.toString();
    });
    proc.stderr.on("data", (c) => {
      stderr += c.toString();
    });
    proc.on("close", () => {
      try {
        const parsed = JSON.parse(stdout) as DevtoolsReport;
        resolve(parsed);
      } catch {
        resolve({
          ok: false,
          generatedAt: new Date().toISOString(),
          windowDays: null,
          tools: [],
          error: stderr.trim() || "failed to read devtools status",
        });
      }
    });
    proc.on("error", (err) => {
      resolve({
        ok: false,
        generatedAt: new Date().toISOString(),
        windowDays: null,
        tools: [],
        error: err.message,
      });
    });
  });
}
