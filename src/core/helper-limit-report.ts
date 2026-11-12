/**
 * One report of the helper limit for Claude Code: the limit in effect and where
 * it comes from, whether it can be applied right now, what it covers, and what
 * helpers ran on across this machine in the last 24 hours.
 *
 * The `devtools helpers` command prints it, and the dashboard's Tools page
 * reads its JSON, so the shape of `HelperLimitReport` is a contract.
 */
import { BUILTIN_ADAPTER_PROFILES } from "./adapters/profiles.ts";
import { resolveHelperLimit, workflowWorkerFullAccessConfig } from "./config.ts";
import {
  formatHelperLimit,
  type HelperLimit,
  type HelperLimitSource,
  helperLadders,
  modelFamily,
} from "./helper-limit.ts";
import type { HelperPluginStatus } from "./helper-plugin.ts";
import { summarizeHelperUsage } from "./helper-usage.ts";
import { findCoordRoot } from "./hooks/resolve/coord-root.ts";
import { readPreferences } from "./preferences.ts";
import {
  floorsBelowHelperLimit,
  parseWorkerFullAccessPolicy,
  type WorkerFullAccessPolicy,
} from "./run/worker-access.ts";

/** The only adapter with a helper limit so far. */
export const HELPER_LIMIT_TOOL = "claude-code";

export interface HelperLimitReport {
  tool: "claude-code";
  /** The limit in effect, or null when helpers are unlimited. */
  limit: HelperLimit | null;
  source: HelperLimitSource;
  /** One sentence describing the limit in effect. */
  summary: string;
  /** The person's own choice: `{}` is the explicit "no limit"; null when none. */
  user: HelperLimit | null;
  project_default: HelperLimit | null;
  /** What a picker may offer, cheapest and lowest first. */
  ladders: { models: string[]; efforts: string[] };
  /** True when the limit can actually be applied to Claude Code helpers now. */
  active: boolean;
  inactive_reason: string | null;
  coverage: { covered: string[]; not_covered: string[] };
  last_24h: { since: string; helpers: number; lowered: number; by_model: Record<string, number> };
  /** Plain sentences, such as a limit that keeps run workers sandboxed. */
  warnings: string[];
}

/** Everything that touches the machine can be replaced, for tests. */
export interface BuildHelperLimitReportOptions {
  /** Project root for the project default and the run worker policy; null for none. */
  coordRoot?: string | null;
  /** The person's preferences file. */
  preferencesPath?: string;
  /** The machine-wide helper usage directory. */
  usageDir?: string;
  now?: Date;
  /** Install state of the Claude Code plugin. Thrown errors read as inactive. */
  pluginStatus?: () => HelperPluginStatus;
  /** Run worker full-access policy; read from the project config when absent. */
  workerFullAccess?: WorkerFullAccessPolicy;
}

export const HELPER_LIMIT_COVERAGE: HelperLimitReport["coverage"] = {
  covered: [
    "Claude Code helpers, including helpers started by helpers and Workflow agents",
    "run workers on Claude Code",
  ],
  not_covered: ["forks", "agent-team teammates", "helpers in Codex, Cursor and OpenCode"],
};

const DAY_MS = 24 * 60 * 60 * 1000;

function claudeLadders() {
  const profile = BUILTIN_ADAPTER_PROFILES[HELPER_LIMIT_TOOL];
  if (!profile) throw new Error(`no adapter profile for ${HELPER_LIMIT_TOOL}`);
  return helperLadders(profile);
}

/**
 * The words after "Helpers run": "on Opus at Medium effort or cheaper",
 * "on Sonnet or cheaper", "at Medium effort or lower". Null when unlimited.
 */
export function helperLimitPhrase(limit: HelperLimit | null | undefined): string | null {
  if (!limit || (limit.max_model === undefined && limit.max_effort === undefined)) return null;
  if (limit.max_model === undefined) return `at ${formatHelperLimit(limit)} or lower`;
  return `on ${formatHelperLimit(limit)} or cheaper`;
}

/** "Helpers run on Opus at Medium effort or cheaper." or "Helpers have no limit." */
export function helperLimitSummary(limit: HelperLimit | null | undefined): string {
  const phrase = helperLimitPhrase(limit);
  return phrase ? `Helpers run ${phrase}.` : "Helpers have no limit.";
}

/** Read the plugin status without letting a failure escape. */
export function safeHelperPluginStatus(
  read: () => HelperPluginStatus,
): { ok: true; status: HelperPluginStatus } | { ok: false; error: string } {
  try {
    return { ok: true, status: read() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function floorWarning(
  limit: HelperLimit,
  policy: WorkerFullAccessPolicy,
  ladders: ReturnType<typeof claudeLadders>,
): string | null {
  if (!policy.enabled || policy.invalid) return null;
  const floors = floorsBelowHelperLimit(policy, HELPER_LIMIT_TOOL, limit, ladders);
  if (floors.length === 0) return null;
  const named = floors
    .map((floor) => formatHelperLimit({ max_model: floor.model, max_effort: floor.minEffort }))
    .join(", ");
  const noun = floors.length === 1 ? "floor" : "floors";
  return `The limit (${formatHelperLimit(limit)}) is below the full-access ${noun} for run workers on Claude Code (${named}), so those run workers will run sandboxed.`;
}

export function buildHelperLimitReport(
  options: BuildHelperLimitReportOptions = {},
): HelperLimitReport {
  const ladders = claudeLadders();
  const root = options.coordRoot === undefined ? findCoordRoot() : options.coordRoot;
  const preferences = readPreferences(options.preferencesPath);
  const resolved = resolveHelperLimit(HELPER_LIMIT_TOOL, { coordRoot: root, preferences });

  let active = false;
  let inactiveReason: string | null = null;
  if (options.pluginStatus) {
    const read = safeHelperPluginStatus(options.pluginStatus);
    if (read.ok) {
      active = read.status.active;
      inactiveReason = active
        ? null
        : (read.status.reason ?? "the Harnery plugin for Claude Code is not active");
    } else {
      inactiveReason = `Harnery could not check its Claude Code plugin (${read.error})`;
    }
  } else {
    inactiveReason = "the Harnery plugin for Claude Code was not checked";
  }

  const now = options.now ?? new Date();
  const usage = summarizeHelperUsage(new Date(now.getTime() - DAY_MS), {
    dir: options.usageDir,
    now,
    tool: HELPER_LIMIT_TOOL,
    family: (model) => modelFamily(model, ladders.models),
  });

  const warnings: string[] = [];
  if (resolved.limit) {
    const policy =
      options.workerFullAccess ??
      (root ? parseWorkerFullAccessPolicy(workflowWorkerFullAccessConfig(root)) : null);
    const warning = policy ? floorWarning(resolved.limit, policy, ladders) : null;
    if (warning) warnings.push(warning);
  }

  return {
    tool: HELPER_LIMIT_TOOL,
    limit: resolved.limit,
    source: resolved.source,
    summary: helperLimitSummary(resolved.limit),
    user: resolved.user ?? null,
    project_default: resolved.project_default,
    ladders: { models: [...ladders.models], efforts: [...ladders.efforts] },
    active,
    inactive_reason: inactiveReason,
    coverage: {
      covered: [...HELPER_LIMIT_COVERAGE.covered],
      not_covered: [...HELPER_LIMIT_COVERAGE.not_covered],
    },
    last_24h: usage,
    warnings,
  };
}
