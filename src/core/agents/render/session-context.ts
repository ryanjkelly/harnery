/**
 * SessionStart UX renderer: combines the peer table, the wiring check, and
 * the pending-council formatter so agent-hook session.start can emit the
 * combined `systemMessage` JSON directly.
 *
 * Outputs a Claude Code SessionStart hookSpecificOutput.additionalContext
 * string.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveBinName } from "../../config.ts";

interface HeartbeatRow {
  instance_id?: string;
  name?: string;
  kind?: string;
  session_id?: string;
  started_at?: string;
  last_heartbeat?: string;
  last_tool?: string;
  last_tool_target?: string;
  files_touched?: string[];
  platform?: string;
  task?: string;
  turn_summary?: string;
}

export interface RenderOpts {
  coordRoot: string;
  instanceId: string;
  sessionId: string;
  agentName?: string;
  /** Harness label rendered in parens after the self-name (e.g. "Cursor", "Codex").
   * Claude Code omits it. */
  platformLabel?: string;
}

/**
 * Build the combined SessionStart systemMessage. Returns the additionalContext
 * string (or "" if there's nothing to say).
 */
export function renderSessionContext(opts: RenderOpts): string {
  const { coordRoot, instanceId, sessionId, agentName, platformLabel } = opts;
  const messages: string[] = [];

  // 1. Self-name line + peer table (folded if peers present)
  const peers = readActivePeers(coordRoot, instanceId);
  const peerTable = formatPeerTable(peers, sessionId);
  if (agentName) {
    const suffix = platformLabel ? ` (${platformLabel})` : "";
    const selfLine = `You are agent-${agentName}${suffix}.`;
    messages.push(peerTable ? `${selfLine}\n\n${peerTable}` : selfLine);
  } else if (peerTable) {
    messages.push(peerTable);
  }

  // 2. Linked-worktree detection
  if (isLinkedWorktree(coordRoot)) {
    messages.push(
      `Running inside worktree ${process.cwd()}. The coord layer is scoped to this worktree only; use \`${resolveBinName(coordRoot)} worktree diff\` to check for conflicts against sibling worktrees.`,
    );
  }

  // 3. Council invites
  if (agentName) {
    const councilMsg = formatPendingCouncils(coordRoot, agentName);
    if (councilMsg) messages.push(councilMsg);
  }

  // 4. Wiring check
  const wiringIssues = checkWiring(coordRoot);
  if (wiringIssues.length > 0) {
    const wiringSummary = `Coordination hooks are NOT wired: the E-guard will not block conflicting commits, and post-commit claim pruning will not run. Run \`scripts/setup-hooks.sh\` to fix. Detected:\n${wiringIssues.map((i) => `  - ${i}`).join("\n")}`;
    messages.push(wiringSummary);
  }

  return messages.join("\n\n");
}

/** Read all peer heartbeats from .harnery/active/, excluding self. */
function readActivePeers(coordRoot: string, selfInstanceId: string): HeartbeatRow[] {
  const out: HeartbeatRow[] = [];
  const dir = join(coordRoot, ".harnery", "active");
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const hb = JSON.parse(readFileSync(join(dir, f), "utf8")) as HeartbeatRow;
      if (!hb.instance_id || hb.instance_id === selfInstanceId) continue;
      out.push(hb);
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Renders the peer table as
 * two subsections: "Other agent groups active" (blocking) and "Your group"
 * (subagents/siblings, no mutual block). Folds transient subagents' files
 * into their parent session.
 */
function formatPeerTable(peers: HeartbeatRow[], mySessionId: string): string {
  if (peers.length === 0) return "";
  const nowSec = Math.floor(Date.now() / 1000);

  // Fold transient peers' files into their session_id parent.
  const fold: Record<string, string[]> = {};
  for (const p of peers) {
    const kind = p.kind ?? "unknown";
    if (kind === "transient" && p.session_id) {
      fold[p.session_id] = (fold[p.session_id] ?? []).concat(p.files_touched ?? []);
    }
  }

  // Build rows with display_files (own files + folded transient files).
  type RowExt = HeartbeatRow & { display_files: string[] };
  const rows: RowExt[] = peers
    .filter((p) => (p.kind ?? "unknown") !== "transient")
    .map((p) => {
      const folded = fold[p.instance_id ?? ""] ?? [];
      const display = Array.from(new Set([...(p.files_touched ?? []), ...folded])).sort();
      return { ...p, display_files: display };
    });

  const blocking = rows.filter((p) => p.session_id !== mySessionId).sort(byStartedAt);
  const group = rows.filter((p) => p.session_id === mySessionId).sort(byStartedAt);

  const sections: string[] = [];
  const blockingSection = renderSubtable(
    blocking,
    "Other agent groups active (their files block you):",
    nowSec,
  );
  if (blockingSection) sections.push(blockingSection);
  const groupSection = renderSubtable(
    group,
    "Your group (subagents / parent / siblings; no mutual block):",
    nowSec,
  );
  if (groupSection) sections.push(groupSection);

  return sections.join("\n\n");
}

function byStartedAt(a: HeartbeatRow, b: HeartbeatRow): number {
  return (a.started_at ?? "").localeCompare(b.started_at ?? "");
}

function renderSubtable(
  rows: Array<HeartbeatRow & { display_files: string[] }>,
  header: string,
  nowSec: number,
): string {
  if (rows.length === 0) return "";
  const first = rows.slice(0, 10).map((r) => formatRow(r, nowSec));
  const overflow = rows.length > 10 ? `\n  +${rows.length - 10} more` : "";
  return `${header}\n${first.join("\n")}${overflow}`;
}

function formatRow(r: HeartbeatRow & { display_files: string[] }, nowSec: number): string {
  const taskPart = r.task ? ` "${r.task.slice(0, 60)}"` : "";
  const ageFrom = fmtAge(nowSec - parseIsoSec(r.started_at));
  const filesPart = fmtFiles(r.display_files);
  const lastActivity = fmtLastActivity(r, nowSec);
  const turnSummary = r.turn_summary ? `\n    last turn: ${r.turn_summary.slice(0, 80)}` : "";
  return `  - agent-${r.name ?? "unknown"}${taskPart}   (${ageFrom}, ${filesPart}${lastActivity})${turnSummary}`;
}

function fmtFiles(files: string[]): string {
  if (files.length === 0) return "nothing yet";
  if (files.length <= 3) return `holds: ${files.join(", ")}`;
  return `holds: ${files.slice(0, 3).join(", ")}, +${files.length - 3} more`;
}

function fmtLastActivity(r: HeartbeatRow, nowSec: number): string {
  if (!r.last_tool) return "";
  const lastTs = parseIsoSec(r.last_heartbeat ?? r.started_at);
  const ageSec = nowSec - lastTs;
  const tail = r.last_tool_target ? ` ${r.last_tool_target.slice(0, 60)}` : "";
  return `, last: ${r.last_tool}${tail} ${fmtAge(ageSec)}`;
}

function parseIsoSec(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function fmtAge(secs: number): string {
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/**
 * Returns a list of wiring issues (empty when everything's wired). Checks
 * parent core.hooksPath + one representative submodule.
 */
export function checkWiring(coordRoot: string): string[] {
  const expected = join(coordRoot, "scripts", "hooks");
  const issues: string[] = [];

  // Parent repo
  const parentHp = gitConfig(coordRoot, "core.hooksPath");
  const parentResolved = resolveHooksPath(coordRoot, parentHp);
  if (parentResolved !== expected) {
    issues.push(
      `parent core.hooksPath=${parentHp || "<unset>"} (resolves to ${parentResolved}, expected ${expected})`,
    );
  }

  // One representative submodule
  const gitmodules = join(coordRoot, ".gitmodules");
  if (existsSync(gitmodules)) {
    const sampleSub = extractFirstSubmodule(gitmodules);
    if (sampleSub) {
      const subPath = join(coordRoot, sampleSub);
      const subGitDir = join(subPath, ".git");
      if (existsSync(subGitDir)) {
        const subHp = gitConfig(subPath, "core.hooksPath");
        const subResolved = resolveSubmoduleHooksPath(coordRoot, sampleSub, subHp);
        if (subResolved !== expected) {
          issues.push(
            `submodule ${sampleSub} core.hooksPath=${subHp || "<unset>"} (resolves to ${subResolved}; other submodules likely affected too)`,
          );
        }
      }
    }
  }

  return issues;
}

function gitConfig(cwd: string, key: string): string {
  const result = spawnSync("git", ["-C", cwd, "config", "--get", key], { encoding: "utf8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function resolveHooksPath(root: string, hp: string): string {
  if (!hp) return join(root, ".git", "hooks");
  if (hp.startsWith("/")) return hp.replace(/\/$/, "");
  return join(root, hp).replace(/\/$/, "");
}

function resolveSubmoduleHooksPath(root: string, sub: string, hp: string): string {
  if (!hp) return join(root, sub, ".git", "hooks");
  if (hp.startsWith("/")) return hp.replace(/\/$/, "");
  return join(root, sub, hp).replace(/\/$/, "");
}

function extractFirstSubmodule(gitmodulesPath: string): string | null {
  try {
    const content = readFileSync(gitmodulesPath, "utf8");
    const match = content.match(/^\s*path\s*=\s*(.+)$/m);
    return match ? match[1]!.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Detect linked-worktree environment (`git worktree` created from the
 * superproject) via a `git rev-parse --git-dir` vs `--git-common-dir` check.
 */
function isLinkedWorktree(coordRoot: string): boolean {
  const dir = spawnSync("git", ["-C", coordRoot, "rev-parse", "--git-dir"], { encoding: "utf8" });
  const common = spawnSync("git", ["-C", coordRoot, "rev-parse", "--git-common-dir"], {
    encoding: "utf8",
  });
  if (dir.status !== 0 || common.status !== 0) return false;
  const d = dir.stdout.trim();
  const c = common.stdout.trim();
  return d !== "" && c !== "" && d !== c;
}

/**
 * Returns the formatted council invite reminder
 * (or "" when no councils await input).
 */
export function formatPendingCouncils(coordRoot: string, agentName: string): string {
  const councilsDir = join(coordRoot, ".harnery", "councils");
  if (!existsSync(councilsDir)) return "";
  const canonicalName = agentName.startsWith("agent-") ? agentName : `agent-${agentName}`;
  const pending: string[] = [];
  try {
    for (const f of readdirSync(councilsDir)) {
      if (!f.endsWith(".json")) continue;
      const manifestPath = join(councilsDir, f);
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          council_id?: string;
          status?: string;
          round_status?: string;
          current_round?: number;
          members?: string[];
        };
        if (m.status !== "active" || m.round_status !== "open") continue;
        if (!m.members?.includes(canonicalName)) continue;
        const round = m.current_round ?? 1;
        const contributionPath = join(
          councilsDir,
          m.council_id ?? "",
          `round-${round}`,
          `${canonicalName}.md`,
        );
        if (existsSync(contributionPath)) continue; // already contributed
        if (m.council_id) pending.push(m.council_id);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }

  if (pending.length === 0) return "";
  const bin = resolveBinName(coordRoot);
  const firstThree = pending.slice(0, 3);
  const tail = pending.length > 3 ? `, +${pending.length - 3} more` : "";
  const list = firstThree.join(", ") + tail;
  if (pending.length === 1) {
    return (
      `Council waiting on your input: \`${pending[0]}\`. ` +
      `Run \`${bin} agents council show ${pending[0]}\` for the brief and ` +
      `\`${bin} agents council contribute ${pending[0]} --message "<your take>"\` to weigh in.`
    );
  }
  return `Councils waiting on your input (${pending.length} open): ${list}. Run \`${bin} agents council list --mine\` to see all of them, then \`${bin} agents council show <id>\` for any brief.`;
}

/**
 * Suppress unused import warning when statSync isn't used in this file
 * (kept exported for future renderers, e.g. heartbeat-freshness coloring).
 */
export const _ensureStatSyncImported = statSync;
