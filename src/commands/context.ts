import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  buildContext,
  type ContextReport,
  DEFAULT_SECTIONS,
  OPT_IN_SECTIONS,
  type SectionName,
} from "../lib/context/index.ts";

/**
 * `harn context`: one-shot orientation snapshot.
 *
 * Aggregates self / time / repo / commits / submodules / peers (default) plus
 * opt-in services. Useful at session start, post-compaction, or before
 * dispatching subagents. Fail-open per section.
 */
export function registerContextCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  program
    .command("context")
    .description(
      `One-shot orientation snapshot: self, repo, submodules, peers, recent commits. Default sections: ${DEFAULT_SECTIONS.join(" / ")}. Opt-in: ${OPT_IN_SECTIONS.join(" / ")}.`,
    )
    .option(
      "--section <name>",
      `Limit to specific sections (comma-list or repeated; valid: ${[...DEFAULT_SECTIONS, ...OPT_IN_SECTIONS].join(", ")})`,
      collectSections,
      [] as SectionName[],
    )
    .option(
      "--include <name>",
      "Add an opt-in section (e.g. services)",
      collectSections,
      [] as SectionName[],
    )
    .option("--show-clean", "Don't hide clean submodules")
    .option("--json", "Structured JSON envelope")
    .action(
      async (opts: {
        section: SectionName[];
        include: SectionName[];
        showClean?: boolean;
        json?: boolean;
      }) => {
        try {
          const sections = opts.section.length > 0 ? opts.section : DEFAULT_SECTIONS;
          const report = await buildContext({
            sections,
            include: opts.include,
            showClean: opts.showClean,
            repoRoot: context?.repoRoot,
            submodules: context?.submodules,
          });
          if (opts.json) {
            emit.config({ format: "json" });
            emit.data(report);
            return;
          }
          emit.text(`${renderReport(report)}\n`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit.error({ code: "context_failed", message: msg });
          process.exit(1);
        }
      },
    );
}

function collectSections(value: string, prev: SectionName[]): SectionName[] {
  const all: SectionName[] = [...DEFAULT_SECTIONS, ...OPT_IN_SECTIONS];
  const out = [...prev];
  for (const tok of value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!all.includes(tok as SectionName)) {
      throw new Error(`unknown section "${tok}". Valid: ${all.join(", ")}`);
    }
    if (!out.includes(tok as SectionName)) out.push(tok as SectionName);
  }
  return out;
}

// ─── TTY rendering ─────────────────────────────────────────────────────────

function renderReport(r: ContextReport): string {
  const lines: string[] = [];
  if (r.self) lines.push(...renderSelf(r.self));
  if (r.time) lines.push(...renderTime(r.time));
  if (r.repo) lines.push(...renderRepo(r.repo));
  if (r.commits) lines.push(...renderCommits(r.commits));
  if (r.submodules) lines.push(...renderSubmodules(r.submodules));
  if (r.peers) lines.push(...renderPeers(r.peers));
  if (r.services) lines.push(...renderServices(r.services));
  lines.push("");
  lines.push(`(elapsed: ${r.meta.elapsed_ms}ms)`);
  return lines.join("\n");
}

function section(header: string, body: string[]): string[] {
  return ["", `── ${header} ──`, ...body];
}

function renderSelf(s: NonNullable<ContextReport["self"]>): string[] {
  if ("error" in s) return section("self", [`  (unavailable: ${s.error})`]);
  const body: string[] = [];
  body.push(
    `  agent-${s.name ?? "?"}  (${formatAge(s.session_age_secs)} old, owner=${s.instance_id.slice(0, 8)}…)`,
  );
  if (s.task) body.push(`  task:    "${s.task}"`);
  if (s.last_tool) {
    const target = s.last_tool_target ? `  ${truncate(s.last_tool_target, 80)}` : "";
    body.push(`  last:    ${s.last_tool}${target}`);
  }
  if (s.files_held.length > 0) {
    body.push(`  holds ${s.files_held.length} file(s):`);
    for (const f of s.files_held.slice(0, 5)) body.push(`    ${f}`);
    if (s.files_held.length > 5) body.push(`    +${s.files_held.length - 5} more`);
  } else {
    body.push("  files:   none held");
  }
  return section("self", body);
}

function renderTime(t: NonNullable<ContextReport["time"]>): string[] {
  return section("time", [`  ${t.chicago}  (UTC: ${t.utc})`]);
}

function renderRepo(r: NonNullable<ContextReport["repo"]>): string[] {
  if ("error" in r) return section("repo", [`  (unavailable: ${r.error})`]);
  const parts: string[] = [];
  const aheadBehind =
    r.ahead > 0 || r.behind > 0 ? ` (ahead ${r.ahead}, behind ${r.behind} vs origin)` : "";
  parts.push(`  cwd:     ${r.cwd}`);
  parts.push(`  branch:  ${r.branch}${aheadBehind}`);
  const dirtyBits: string[] = [];
  if (r.staged) dirtyBits.push(`${r.staged} staged`);
  if (r.modified) dirtyBits.push(`${r.modified} modified`);
  if (r.untracked) dirtyBits.push(`${r.untracked} untracked`);
  parts.push(`  status:  ${dirtyBits.length ? dirtyBits.join(", ") : "clean"}`);
  return section("repo", parts);
}

function renderCommits(c: NonNullable<ContextReport["commits"]>): string[] {
  if ("error" in c) return section("commits", [`  (unavailable: ${c.error})`]);
  if (c.rows.length === 0) return section("commits", ["  (none)"]);
  return section(
    "commits (last 3)",
    c.rows.map((row) => `  ${row.sha}  ${truncate(row.subject, 80)}`),
  );
}

function renderSubmodules(s: NonNullable<ContextReport["submodules"]>): string[] {
  if ("error" in s) return section("submodules", [`  (unavailable: ${s.error})`]);
  if (s.rows.length === 0) {
    const tail = s.clean_omitted > 0 ? ` (${s.clean_omitted} clean omitted)` : "";
    return section("submodules", [`  all clean${tail}`]);
  }
  const lines = s.rows.map((sm) => {
    const aheadBehind = sm.ahead > 0 || sm.behind > 0 ? ` ±${sm.ahead}/${sm.behind}` : "";
    const dirty = sm.dirty ? ` (${sm.modifiedFiles}m+${sm.untrackedFiles}u)` : "";
    return `  ${sm.name.padEnd(28)} ${sm.branch}${aheadBehind}${dirty}`;
  });
  const tail = s.clean_omitted > 0 ? [`  (+${s.clean_omitted} clean omitted)`] : [];
  return section("submodules", [...lines, ...tail]);
}

function renderPeers(p: NonNullable<ContextReport["peers"]>): string[] {
  if ("error" in p) return section("peers", [`  (unavailable: ${p.error})`]);
  if (p.rows.length === 0) return section("peers", ["  (none active)"]);
  const lines = p.rows.map((peer) => {
    const taskBit = peer.task ? ` "${truncate(peer.task, 40)}"` : "";
    const filesBit = peer.files > 0 ? `${peer.files}f` : "0f";
    const lastBit = peer.last_tool ? `, last: ${peer.last_tool}` : "";
    return `  agent-${peer.name.padEnd(12)}${taskBit}  (${peer.age_min}m old, ${filesBit}${lastBit})`;
  });
  return section("peers", lines);
}

function renderServices(s: NonNullable<ContextReport["services"]>): string[] {
  if ("error" in s) return section("services", [`  (unavailable: ${s.error})`]);
  if (s.docker_compose.length === 0) return section("services", ["  (no compose project running)"]);
  const lines = s.docker_compose.map((sv) => `  ${sv.service.padEnd(20)} ${sv.status}`);
  return section("services (docker compose)", lines);
}

// ─── Format helpers ────────────────────────────────────────────────────────

function formatAge(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return `${h}h ${m}m`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return `${d}d ${h}h`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
