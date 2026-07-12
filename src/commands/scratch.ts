import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, watch } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { emitCanonical, normalizeHarness, readHeartbeat } from "../core/agents/index.ts";
import { resolveBinName } from "../core/config.ts";
import {
  appendEntry,
  archiveScratch,
  currentOwnerOrThrow,
  lintScratch,
  listArchives,
  loadScratch,
  parseScratch,
  pruneArchives,
  resolveOwnerByName,
  SCRATCH_CATEGORIES,
  type ScratchCategory,
  type ScratchDoc,
  scratchDir,
  scratchPath,
  sweepOrphanScratchpads,
} from "../core/scratch/index.ts";

/**
 * `harn scratch`: per-agent markdown journal at `.harnery/scratch/<instance_id>.md`.
 * Used both for self-notes (surviving compaction) and peer coordination (other
 * agents pull-read it on demand). SessionEnd hook archives; SessionStart
 * janitor surfaces the most-recent archive as a recovery cue.
 */
let emit: EmitContext;

export function registerScratchCommand(program: Command, emitParam: EmitContext): void {
  emit = emitParam;
  const root = program
    .command("scratch")
    .description(
      "Per-agent markdown journal: append-only timestamped entries. " +
        "Survives in-session compaction, archived at session end, pruned after 7 days.",
    );

  // ── add ───────────────────────────────────────────────────────────────
  root
    .command("add <category> <text...>")
    .description(`Append an entry to my scratchpad. Category: ${SCRATCH_CATEGORIES.join(" | ")}`)
    .action((category: string, text: string[]) => {
      const cat = validateCategory(category);
      const body = text.join(" ");
      if (!body.trim()) {
        emit.error({ code: "empty_body", message: "scratch add: body is empty" });
        process.exit(1);
      }
      try {
        const owner = currentOwnerOrThrow();
        const doc = appendEntry(owner, cat, body);
        const hb = readHeartbeat(owner);
        emitCanonical({
          type: "state.scratch_append",
          owner,
          session: hb?.session_id ?? owner,
          harness: normalizeHarness(hb?.platform),
          data: {
            category: cat,
            body_summary: body.length > 1000 ? `${body.slice(0, 997)}...` : body,
          },
        });
        emit.data({
          instance_id: owner,
          name: doc.header.name,
          category: cat,
          entries: doc.entries.length,
          bytes: doc.bytes,
          path: doc.path,
        });
      } catch (err) {
        emit.error({ code: "add_failed", message: (err as Error).message });
        process.exit(1);
      }
    });

  // ── read ──────────────────────────────────────────────────────────────
  root
    .command("read")
    .description("Render a scratchpad to stdout. No --name: my own. With --name: a peer's.")
    .option("--name <name>", "Read the named peer's scratchpad (case-insensitive)")
    .option("--owner <id>", "Read by instance_id directly")
    .option("--archive <basename>", "Read an archive file (e.g. <owner>-<ts>.md)")
    .option("--limit <n>", "Cap entries rendered (newest first)", "50")
    .action((opts: { name?: string; owner?: string; archive?: string; limit: string }) => {
      try {
        runRead(opts);
      } catch (err) {
        emit.error({ code: "read_failed", message: (err as Error).message });
        process.exit(1);
      }
    });

  // ── list ──────────────────────────────────────────────────────────────
  root
    .command("list")
    .description("Summarize all active scratchpads + archive count")
    .option("--archives", "List archive files instead of active scratchpads")
    .action((opts: { archives?: boolean }) => {
      try {
        if (opts.archives) {
          const items = listArchives().map((a) => {
            const doc = parseSafe(a.path);
            const lastEntry = doc?.entries[0];
            const ageMin = Math.floor((Date.now() - a.mtimeMs) / 60000);
            return {
              basename: a.basename,
              name: doc?.header.name ?? "unknown",
              entries: doc?.entries.length ?? 0,
              bytes: a.bytes,
              archived_min_ago: ageMin,
              last_category: lastEntry?.category ?? null,
              last_ts: lastEntry?.ts_display ?? null,
            };
          });
          emit.data({ rows: items });
          return;
        }
        const dir = scratchDir();
        const rows: Array<{
          instance_id: string;
          name: string;
          entries: number;
          bytes: number;
          last_category: string | null;
          last_ts: string | null;
        }> = [];
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".md")) continue;
          const instanceId = f.replace(/\.md$/, "");
          const doc = loadScratch(instanceId);
          if (!doc) continue;
          rows.push({
            instance_id: instanceId,
            name: doc.header.name,
            entries: doc.entries.length,
            bytes: doc.bytes,
            last_category: doc.entries[0]?.category ?? null,
            last_ts: doc.entries[0]?.ts_display ?? null,
          });
        }
        rows.sort((a, b) => (b.last_ts ?? "").localeCompare(a.last_ts ?? ""));
        emit.data({ rows });
      } catch (err) {
        emit.error({ code: "list_failed", message: (err as Error).message });
        process.exit(1);
      }
    });

  // ── tail ──────────────────────────────────────────────────────────────
  root
    .command("tail")
    .description("Follow my scratchpad (or a peer's) for new entries.")
    .option("--name <name>", "Tail the named peer's scratchpad")
    .option("--owner <id>", "Tail by instance_id directly")
    .action(async (opts: { name?: string; owner?: string }) => {
      try {
        const owner = resolveTargetOwner(opts);
        const path = scratchPath(owner);
        if (!existsSync(path)) {
          emit.error({ code: "no_scratchpad", message: `no scratchpad at ${path} yet` });
          process.exit(1);
        }
        process.stderr.write(`tailing ${path}\n`); // lint-ok-emission: tail banner, immediate stderr flush before streaming
        let lastSize = statSync(path).size;
        // Print initial render
        process.stdout.write(`${renderScratch(loadScratch(owner)!, 10)}\n`); // lint-ok-emission: streaming tail body
        const w = watch(path, { persistent: true }, () => {
          try {
            const curr = statSync(path).size;
            if (curr === lastSize) return;
            lastSize = curr;
            const doc = loadScratch(owner);
            if (!doc) return;
            const newest = doc.entries[0];
            if (!newest) return;
            const line = `\n## ${newest.ts_display} · ${newest.category}\n${newest.body}\n`;
            process.stdout.write(line); // lint-ok-emission: streaming tail, per-line stdout flush, no envelope wrap
          } catch {
            // ignore transient
          }
        });
        await new Promise<void>((resolveP) => {
          const stop = () => {
            w.close();
            resolveP();
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        });
      } catch (err) {
        emit.error({ code: "tail_failed", message: (err as Error).message });
        process.exit(1);
      }
    });

  // ── clear ─────────────────────────────────────────────────────────────
  root
    .command("clear")
    .description("Delete my scratchpad (rare; mainly for testing)")
    .option("--yes", "Confirm deletion")
    .action((opts: { yes?: boolean }) => {
      if (!opts.yes) {
        emit.error({ code: "needs_yes", message: "pass --yes to confirm" });
        process.exit(1);
      }
      try {
        const owner = currentOwnerOrThrow();
        const path = scratchPath(owner);
        if (existsSync(path)) {
          unlinkSync(path);
          emit.data({ cleared: true, path });
        } else {
          emit.data({ cleared: false, path, reason: "did not exist" });
        }
      } catch (err) {
        emit.error({ code: "clear_failed", message: (err as Error).message });
        process.exit(1);
      }
    });

  // ── lint ──────────────────────────────────────────────────────────────
  root
    .command("lint")
    .description("Validate scratchpad format + size")
    .option("--all", "Lint every scratchpad in .harnery/scratch/")
    .option("--owner <id>", "Lint a specific owner's scratchpad")
    .action((opts: { all?: boolean; owner?: string }) => {
      try {
        runLint(opts);
      } catch (err) {
        emit.error({ code: "lint_failed", message: (err as Error).message });
        process.exit(1);
      }
    });

  // ── archive (manual / hook helper) ────────────────────────────────────
  root
    .command("archive")
    .description("Archive my scratchpad now (idempotent; fired by SessionEnd hook)")
    .option("--owner <id>", "Archive a specific owner's scratchpad")
    .action((opts: { owner?: string }) => {
      try {
        const owner = opts.owner ?? currentOwnerOrThrow();
        const dest = archiveScratch(owner);
        emit.data({ instance_id: owner, archived: !!dest, path: dest });
      } catch (err) {
        emit.error({ code: "archive_failed", message: (err as Error).message });
        process.exit(1);
      }
    });

  // ── recovery-cue (SessionStart hook helper) ───────────────────────────
  root
    .command("recovery-cue")
    .description(
      "Emit a one-line recovery hint to stdout when a recent archive exists. " +
        "Used by SessionStart hook to surface 'previous session was doing X'. " +
        "Stays silent when no relevant archive (no noise on fresh sessions).",
    )
    .option("--max-age-hours <n>", "Only surface archives newer than this", "24")
    .action((opts: { maxAgeHours: string }) => {
      try {
        const maxHours = Number.parseInt(opts.maxAgeHours, 10);
        const archives = listArchives();
        if (archives.length === 0) return;
        const newest = archives[0];
        const ageHours = (Date.now() - newest.mtimeMs) / 3600_000;
        if (ageHours > maxHours) return;
        const doc = parseSafe(newest.path);
        if (!doc || doc.entries.length === 0) return;
        const last = doc.entries[0];
        const ageMin = Math.floor((Date.now() - newest.mtimeMs) / 60_000);
        const ageStr = ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m`;
        const bodyOneLine = last.body.replace(/\s+/g, " ").trim();
        const bodyTrunc = bodyOneLine.length > 100 ? `${bodyOneLine.slice(0, 99)}…` : bodyOneLine;
        const cue =
          `Recent scratchpad archive (${ageStr} ago): agent-${doc.header.name}: ` +
          `last entry [${last.category}] "${bodyTrunc}". ` +
          `Read full: \`${resolveBinName()} scratch read --archive ${newest.basename}\`.`;
        process.stdout.write(`${cue}\n`); // lint-ok-emission: bash hook reads stdout to compose SessionStart additionalContext
      } catch (_err) {
        // Recovery cue is best-effort; never fail the SessionStart hook.
      }
    });

  // ── janitor (SessionStart hook) ───────────────────────────────────────
  root
    .command("janitor")
    .description(
      "Prune old archives + sweep orphan scratchpads (heartbeat gone). Fired by SessionStart hook.",
    )
    .option("--days <n>", "Archive retention in days", "7")
    .option("--quiet", "Suppress stdout output")
    .action((opts: { days: string; quiet?: boolean }) => {
      try {
        const days = Number.parseInt(opts.days, 10);
        const swept = sweepOrphanScratchpads();
        const pruned = pruneArchives(days);
        if (!opts.quiet) {
          emit.data({
            archives_pruned: pruned,
            orphans_swept: swept.length,
            orphans: swept,
          });
        }
      } catch (err) {
        emit.error({ code: "janitor_failed", message: (err as Error).message });
        process.exit(1);
      }
    });
}

// ─── runRead ──────────────────────────────────────────────────────────────

function runRead(opts: { name?: string; owner?: string; archive?: string; limit: string }): void {
  const limit = Number.parseInt(opts.limit, 10);
  if (opts.archive) {
    const dir = scratchDir();
    const path = resolvePath(dir, "archived", opts.archive);
    if (!existsSync(path)) {
      emit.error({ code: "no_archive", message: `archive not found: ${opts.archive}` });
      process.exit(1);
    }
    const content = readFileSync(path, "utf8");
    process.stdout.write(content); // lint-ok-emission: archive render, file content is already the rendered form
    return;
  }

  const owner = resolveTargetOwner(opts);
  const doc = loadScratch(owner);
  if (!doc) {
    emit.error({
      code: "no_scratchpad",
      message: `no scratchpad for owner=${owner.slice(0, 8)}… (file not created yet)`,
    });
    process.exit(1);
  }

  const hb = readHeartbeat(owner);
  const staleBanner = renderStaleBannerIfNeeded(hb?.last_heartbeat);
  process.stdout.write(`${staleBanner + renderScratch(doc, limit)}\n`); // lint-ok-emission: pretty render, multi-line markdown for direct TTY/pipe consumption
}

function runLint(opts: { all?: boolean; owner?: string }): void {
  const dir = scratchDir();
  const files: string[] = [];
  if (opts.owner) {
    files.push(scratchPath(opts.owner));
  } else if (opts.all) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".md")) files.push(resolvePath(dir, f));
    }
  } else {
    const owner = currentOwnerOrThrow();
    files.push(scratchPath(owner));
  }
  let totalIssues = 0;
  const reports: Array<{ path: string; issues: { line: number; message: string }[] }> = [];
  for (const path of files) {
    if (!existsSync(path)) {
      reports.push({ path, issues: [{ line: 0, message: "(file does not exist)" }] });
      continue;
    }
    const content = readFileSync(path, "utf8");
    const issues = lintScratch(content);
    if (issues.length > 0) totalIssues += issues.length;
    reports.push({ path, issues });
  }
  emit.data({ files: reports.length, total_issues: totalIssues, reports });
  if (totalIssues > 0) process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function validateCategory(c: string): ScratchCategory {
  if (!(SCRATCH_CATEGORIES as readonly string[]).includes(c)) {
    emit.error({
      code: "bad_category",
      message: `category must be one of: ${SCRATCH_CATEGORIES.join(", ")}`,
    });
    process.exit(1);
  }
  return c as ScratchCategory;
}

function resolveTargetOwner(opts: { name?: string; owner?: string }): string {
  if (opts.owner) return opts.owner;
  if (opts.name) {
    const id = resolveOwnerByName(opts.name);
    if (!id) {
      emit.error({
        code: "no_match",
        message: `no live agent named "${opts.name}". Try \`${resolveBinName()} agents list\`.`,
      });
      process.exit(1);
    }
    return id;
  }
  return currentOwnerOrThrow();
}

function renderScratch(doc: ScratchDoc, limit: number): string {
  const lines: string[] = [];
  lines.push(`# Scratchpad: agent-${doc.header.name}`);
  if (doc.header.session_id) lines.push(`session_id: ${doc.header.session_id}`);
  if (doc.header.machine) lines.push(`machine: ${doc.header.machine}`);
  if (doc.header.started) lines.push(`started: ${doc.header.started}`);
  if (doc.header.last_updated) lines.push(`last_updated: ${doc.header.last_updated}`);
  lines.push("\n---\n");
  for (const entry of doc.entries.slice(0, limit)) {
    lines.push(`## ${entry.ts_display} · ${entry.category}`);
    if (entry.body) lines.push(entry.body);
    lines.push("");
  }
  if (doc.entries.length > limit) {
    lines.push(`(+${doc.entries.length - limit} older entries; raise --limit to see them)`);
  }
  return lines.join("\n").trimEnd();
}

const FRESHNESS_SECS = 600;
function renderStaleBannerIfNeeded(lastHeartbeat: string | undefined): string {
  if (!lastHeartbeat) return "";
  const ts = Date.parse(lastHeartbeat);
  if (!Number.isFinite(ts)) return "";
  const ageSec = Math.floor((Date.now() - ts) / 1000);
  if (ageSec < FRESHNESS_SECS) return "";
  const m = Math.floor(ageSec / 60);
  return `[STALE: heartbeat ${m}m old, agent may be dead]\n\n`;
}

function parseSafe(path: string): ScratchDoc | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, "utf8");
    return parseScratch(path, content);
  } catch {
    return null;
  }
}
