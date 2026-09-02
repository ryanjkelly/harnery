// `review-pack create <target>` / `review-pack judge <dir>`: build a page
// review pack (tiles, DOM, signature per rendering context, plus review.md)
// and judge one from disk through one bounded pool of vision calls. qa-run
// composes the same two library halves; this command exposes them directly
// so an agent can prepare a page for review, or review a pack, on its own.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { artifactsRoot } from "../core/artifacts/index.ts";
import { resolveBinName, reviewPackAutoCleanEnabled } from "../core/config.ts";
import { createManagedQaOutParent, resolveQaRepoRoot } from "../core/qa-artifacts.ts";
import { DEFAULT_CRITIQUE_RUBRIC } from "../lib/browser/critique.ts";
import { judgePageReviewPack, toCritiqueRecords } from "../lib/browser/page-review-judge.ts";
import {
  aggregateMachineOutcome,
  deleteExpiredPacks,
  expandedTileFilename,
  finalizePageReviewPack,
  findPackTile,
  findPageReviewPacks,
  isPackDeletable,
  listPackContexts,
  machineFindingTargets,
  PAGE_REVIEW_DEFAULT_RETENTION_MINUTES,
  PAGE_REVIEW_DISPOSITIONS,
  PAGE_REVIEW_FINDING_CATEGORIES,
  PAGE_REVIEW_FINDING_SEVERITIES,
  PAGE_REVIEW_SUBAGENT_MODELS,
  PAGE_REVIEW_VERDICT_SCHEMA,
  type PageReviewContextRecord,
  type PageReviewDisposition,
  type PageReviewFindingCategory,
  type PageReviewFindingSeverity,
  type PageReviewFindingsDocument,
  type PageReviewPackManifest,
  type PageReviewPackRow,
  type PageReviewRetention,
  type PageReviewVerdictDocument,
  packPaths,
  readPackContext,
  readPackFindings,
  readPackInspectionPlan,
  readPackManifest,
  readPackVerdict,
  resolvePackVerdict,
  validateFindingsDocument,
  writePackFindings,
} from "../lib/browser/page-review-pack.ts";
import { defaultQaRunExec, QA_RUN_HEADLESS_ONLY_ENV } from "../lib/browser/qa-run.ts";
import { contextIdFor, type QaRunContext } from "../lib/browser/qa-run-contracts.ts";

interface CreateOpts {
  out?: string;
  context?: string[];
  scope?: string[];
  noBands?: boolean;
  maxTiles?: string;
  concurrency?: string;
  timeout?: string;
  retain?: string;
  json?: boolean;
}

interface JudgeOpts {
  pool?: string;
  allowMetered?: boolean;
  context?: string[];
  retain?: string;
  json?: boolean;
}

interface CleanOpts {
  root?: string;
  yes?: boolean;
  includeUnmanaged?: boolean;
  json?: boolean;
}

interface ListOpts {
  root?: string;
  json?: boolean;
}

interface PackListRow {
  dir: string;
  target: string;
  created_at: string;
  age_minutes: number;
  size_bytes: number | null;
  contexts: number;
  tiles: number;
  machine_outcome: string | null;
  reviewed_outcome: string | null;
  expires_at: string | null;
  managed: boolean | null;
  expired: boolean;
}

function packListRow(
  dir: string,
  manifest: ReturnType<typeof readPackManifest>,
  verdict: ReturnType<typeof readPackVerdict>,
  nowMs: number,
): PackListRow {
  const expiresAt = manifest.retention?.expires_at ?? null;
  const expiresMs = expiresAt === null ? Number.NaN : Date.parse(expiresAt);
  return {
    dir,
    target: manifest.target,
    created_at: manifest.created_at,
    age_minutes: Math.max(0, Math.round((nowMs - Date.parse(manifest.created_at)) / 60_000)),
    size_bytes: typeof manifest.size_bytes === "number" ? manifest.size_bytes : null,
    contexts: manifest.contexts.length,
    tiles: manifest.contexts.reduce((sum, ctx) => sum + ctx.tiles.length, 0),
    machine_outcome: aggregateMachineOutcome(manifest.critique),
    reviewed_outcome: verdict?.reviewed_outcome ?? null,
    expires_at: expiresAt,
    managed: typeof manifest.retention?.managed === "boolean" ? manifest.retention.managed : null,
    expired: Number.isFinite(expiresMs) && expiresMs <= nowMs,
  };
}

function packListLine(row: PackListRow): string {
  const age =
    row.age_minutes < 120 ? `${row.age_minutes}m` : `${Math.round(row.age_minutes / 60)}h`;
  const expiry = row.expires_at
    ? row.expired
      ? `expired${row.managed === false ? " (unmanaged)" : ""}`
      : row.expires_at
    : "no retention";
  return (
    `${age.padStart(6)} ${formatBytes(row.size_bytes).padStart(9)} ${String(row.contexts).padStart(3)} ` +
    `${String(row.tiles).padStart(5)} ${(row.machine_outcome ?? "-").padEnd(10)} ` +
    `${(row.reviewed_outcome ?? "-").padEnd(10)} ${expiry.padEnd(26)} ${row.dir}`
  );
}

interface ExpandOpts {
  tile?: string;
  context?: string;
  dpr?: string;
  timeout?: string;
  json?: boolean;
}

interface FindingsAddOpts {
  context?: string;
  tile?: string[];
  severity?: string;
  category?: string;
  observation?: string;
  recommendation?: string;
  id?: string;
  reviewer?: string;
  json?: boolean;
}

interface ReviewAddOpts {
  reviewer?: string;
  model?: string;
  assigned?: string[];
  completed?: string[];
  status?: string;
  json?: boolean;
}

interface DispositionOpts {
  note?: string;
  by?: string;
  json?: boolean;
}

interface VerdictOpts {
  json?: boolean;
}

/** Next free review-subagent finding id in the `F001` series. */
function nextFindingId(findings: ReadonlyArray<{ id: string }>): string {
  let max = 0;
  for (const finding of findings) {
    const match = /^F(\d+)$/.exec(finding.id);
    if (match) max = Math.max(max, Number.parseInt(match[1] ?? "0", 10));
  }
  return `F${String(max + 1).padStart(3, "0")}`;
}

/** Read the manifest and findings of a pack, or emit one error and return undefined. */
function readReviewerPack(
  dir: string,
  emit: EmitContext,
):
  | { packDir: string; manifest: PageReviewPackManifest; findings: PageReviewFindingsDocument }
  | undefined {
  const packDir = resolve(dir);
  let manifest: PageReviewPackManifest;
  try {
    manifest = readPackManifest(packDir);
  } catch (err: unknown) {
    emit.error({
      code: "review_pack_unreadable",
      message: `not a page review pack: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exitCode = 1;
    return undefined;
  }
  let findings: PageReviewFindingsDocument;
  try {
    findings = readPackFindings(packDir);
  } catch (err: unknown) {
    emit.error({
      code: "review_pack_findings_unreadable",
      message: `findings.json unreadable: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exitCode = 1;
    return undefined;
  }
  return { packDir, manifest, findings };
}

/** Validate then write findings.json; on violations emit every one and return false. */
function commitFindings(
  packDir: string,
  doc: PageReviewFindingsDocument,
  emit: EmitContext,
): boolean {
  const errors = validateFindingsDocument(doc);
  if (errors.length > 0) {
    for (const error of errors) emit.log(`findings.json: ${error}`, "error");
    emit.error({
      code: "review_pack_findings_invalid",
      message: `${errors.length} validation error(s); findings.json was not written`,
    });
    process.exitCode = 1;
    return false;
  }
  writePackFindings(packDir, doc);
  return true;
}

/** Rewrite review.md and the evidence files from the manifest on disk, the way `judge` does. */
function refreshPackFromManifest(packDir: string, manifest: PageReviewPackManifest): void {
  finalizePageReviewPack({
    packDir,
    target: manifest.target,
    ...(manifest.tested_revision !== undefined
      ? { tested_revision: manifest.tested_revision }
      : {}),
    contexts: manifest.contexts,
    gates: manifest.gates,
    critique: manifest.critique,
    ...(manifest.pool ? { pool: manifest.pool } : {}),
    warnings: manifest.warnings.filter((w) => !w.includes("tile cap reached")),
    createdAt: manifest.created_at,
    judgeCommand: judgeCommandFor(packDir),
  });
}

const DEFAULT_CONTEXTS: QaRunContext[] = [
  { id: "desktop-light-default", viewport: "desktop", theme: "light", state: "default" },
  { id: "mobile-light-default", viewport: "mobile", theme: "light", state: "default" },
  { id: "desktop-dark-default", viewport: "desktop", theme: "dark", state: "default" },
  { id: "mobile-dark-default", viewport: "mobile", theme: "dark", state: "default" },
];

/** `<viewport>:<theme>:<state>` → context; theme and state default. */
function parseContext(spec: string): QaRunContext {
  const [viewport, themeRaw = "light", state = "default"] = spec.split(":");
  if (!viewport) {
    throw new Error(
      `invalid --context ${JSON.stringify(spec)}: expected <viewport>[:<theme>[:<state>]]`,
    );
  }
  if (themeRaw !== "light" && themeRaw !== "dark") {
    throw new Error(`invalid --context ${JSON.stringify(spec)}: theme must be light or dark`);
  }
  const theme: "light" | "dark" = themeRaw;
  const base = { viewport, theme, state };
  return { id: contextIdFor(base), ...base };
}

function judgeCommandFor(packDir: string): string {
  return `${resolveBinName()} review-pack judge ${packDir}`;
}

/** `--retain <minutes>` → minutes, or an error message. */
function parseRetainMinutes(raw: string | undefined): number | { error: string } {
  if (raw === undefined) return PAGE_REVIEW_DEFAULT_RETENTION_MINUTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > 43_200) {
    return { error: "--retain must be an integer between 1 and 43200 (minutes)" };
  }
  return n;
}

/** Retention that ends `minutes` from now. */
function retentionFromNow(minutes: number, managed: boolean): PageReviewRetention {
  return { expires_at: new Date(Date.now() + minutes * 60_000).toISOString(), managed };
}

/** Delete expired managed packs from the artifact store when
 * `review_pack.auto_clean` is on; a failed sweep is a warning, never a blocker. */
function sweepExpiredPacksIfEnabled(repoRoot: string, emit: EmitContext): void {
  if (!reviewPackAutoCleanEnabled(repoRoot)) return;
  try {
    const swept = deleteExpiredPacks({ roots: [artifactsRoot(repoRoot)], dryRun: false });
    if (swept.deleted.length > 0) {
      emit.log(
        `removed ${swept.deleted.length} expired page review pack${swept.deleted.length === 1 ? "" : "s"}`,
        "info",
      );
    }
  } catch (err: unknown) {
    emit.log(
      `expired pack sweep skipped: ${err instanceof Error ? err.message : String(err)}`,
      "warn",
    );
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function packRowLine(row: PageReviewPackRow, includeUnmanaged: boolean): string {
  const state = isPackDeletable(row, includeUnmanaged)
    ? "delete"
    : row.expired
      ? row.managed === false
        ? "expired (unmanaged, kept)"
        : "expired (no retention, kept)"
      : row.expires_at
        ? `expires ${row.expires_at}`
        : "no retention";
  return `${state.padEnd(28)} ${formatBytes(row.size_bytes).padStart(9)}  ${row.dir}  ${row.target}`;
}

export function registerReviewPackCommand(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const root = program
    .command("review-pack")
    .description(
      "Page review packs: capture a page's rendering contexts (tiles, DOM, signature) " +
        "into a directory an agent can review without a browser, and judge a pack from " +
        "disk through one bounded pool of vision calls.",
    );

  root
    .command("create <target>")
    .description(
      "Render each context once through child browse processes into <out>/contexts/<id>/, " +
        "closing every browser before any vision call, then write review.md, the inspection " +
        "plan, coverage, and a findings.json skeleton. Judge afterwards with `review-pack judge`.",
    )
    .option("--out <dir>", "Pack directory (default: a managed .harnery/artifacts workspace).")
    .option(
      "--context <spec>",
      "Rendering context <viewport>[:<theme>[:<state>]] (repeatable; default desktop and " +
        "mobile in light and dark).",
      (value: string, previous: string[] = []) => [...previous, value],
      [] as string[],
    )
    .option(
      "--scope <selector>",
      "Also tile one screenshot per element matching <selector> (repeatable).",
      (value: string, previous: string[] = []) => [...previous, value],
      [] as string[],
    )
    .option("--no-bands", "Keep only --scope tiles; skip full-page bands.")
    .option(
      "--max-tiles <n>",
      "Full-page band cap per context (browse --check-critique-max-tiles).",
    )
    .option("--concurrency <n>", "Concurrent capture browsers (1-8; default 2).", "2")
    .option("--timeout <ms>", "Per-capture timeout in milliseconds (default 120000).", "120000")
    .option(
      "--retain <minutes>",
      `Minutes the pack lives before the whole directory is deleted (1-43200; default ` +
        `${PAGE_REVIEW_DEFAULT_RETENTION_MINUTES}). A later judge restarts the clock. A pack ` +
        "written to --out is unmanaged and never deleted automatically.",
    )
    .option("--json", "Print the pack manifest as JSON.")
    .action(async (target: string, opts: CreateOpts) => {
      const retainMinutes = parseRetainMinutes(opts.retain);
      if (typeof retainMinutes !== "number") {
        emit.error({ code: "review_pack_invalid_retain", message: retainMinutes.error });
        process.exitCode = 1;
        return;
      }
      let contexts: QaRunContext[];
      try {
        contexts = opts.context?.length ? opts.context.map(parseContext) : DEFAULT_CONTEXTS;
      } catch (err: unknown) {
        emit.error({
          code: "review_pack_invalid_context",
          message: err instanceof Error ? err.message : String(err),
        });
        process.exitCode = 1;
        return;
      }
      const concurrency = Math.max(
        1,
        Math.min(8, Number.parseInt(opts.concurrency ?? "2", 10) || 2),
      );
      const timeoutMs = Math.max(1000, Number.parseInt(opts.timeout ?? "120000", 10) || 120_000);
      const repoRoot = resolveQaRepoRoot(context);
      sweepExpiredPacksIfEnabled(repoRoot, emit);
      let packDir: string;
      try {
        packDir =
          opts.out !== undefined
            ? resolve(opts.out)
            : createManagedQaOutParent(repoRoot, "review-pack");
        mkdirSync(packDir, { recursive: true });
      } catch (err: unknown) {
        emit.error({
          code: "review_pack_output_unavailable",
          message: `cannot create the pack directory: ${err instanceof Error ? err.message : String(err)}`,
        });
        process.exitCode = 1;
        return;
      }
      const cliScript = process.argv[1];
      if (!cliScript) {
        emit.error({
          code: "review_pack_no_cli_script",
          message: "cannot resolve the host CLI script path for child browse invocations",
        });
        process.exitCode = 1;
        return;
      }
      // Children run the same host CLI so profiles, cookies, and headers match
      // a hand-run browse byte for byte.
      const browseArgv = [process.execPath, cliScript, "browse"];
      const env = { ...process.env };
      const records: PageReviewContextRecord[] = [];
      const failures: Array<{ context_id: string; reason: string }> = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const index = next++;
          const ctx = contexts[index];
          if (!ctx) return;
          const argv = [
            ...browseArgv,
            target,
            "--viewport",
            ctx.viewport,
            ...(ctx.theme === "dark" ? ["--color-scheme", "dark"] : []),
            "--out",
            resolve(packDir, "..", `${ctx.id}-capture`),
            "--no-screenshot",
            "--review-pack",
            packDir,
            "--review-pack-context",
            ctx.id,
            "--qa-theme",
            ctx.theme,
            "--qa-state",
            ctx.state,
            ...(opts.noBands ? ["--no-review-pack-bands"] : []),
            ...(opts.scope ?? []).flatMap((selector) => ["--review-pack-scope", selector]),
            ...(opts.maxTiles !== undefined ? ["--check-critique-max-tiles", opts.maxTiles] : []),
          ];
          emit.log(`capture ${ctx.id}`, "info");
          const res = await defaultQaRunExec(argv, { timeoutMs, env });
          if (res.error || res.exitCode !== 0) {
            const tail = (res.stderr || res.stdout).trim().split("\n").slice(-3).join(" ");
            failures.push({
              context_id: ctx.id,
              reason: res.error ?? `exit code ${res.exitCode}${tail ? `: ${tail}` : ""}`,
            });
            continue;
          }
          try {
            records.push(readPackContext(packDir, ctx.id));
          } catch (err: unknown) {
            failures.push({
              context_id: ctx.id,
              reason: `pack context unreadable: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, contexts.length) }, worker));
      // Manifest order regardless of completion order.
      records.sort(
        (a, b) =>
          contexts.findIndex((c) => c.id === a.id) - contexts.findIndex((c) => c.id === b.id),
      );
      for (const failure of failures) {
        emit.log(`capture ${failure.context_id} failed: ${failure.reason}`, "warn");
      }
      if (records.length === 0) {
        emit.error({
          code: "review_pack_no_contexts",
          message: "no context was captured; see the capture failures above",
        });
        process.exitCode = 1;
        return;
      }
      const out = finalizePageReviewPack({
        packDir,
        target,
        contexts: records,
        critique: null,
        warnings: failures.map(
          (f) => `${f.context_id}: capture failed (${f.reason}); not in this pack`,
        ),
        judgeCommand: judgeCommandFor(packDir),
        // The clock starts at capture; the judge restarts it when it runs.
        retention: retentionFromNow(retainMinutes, opts.out === undefined),
      });
      const manifest = readPackManifest(packDir);
      emit.log(
        `pack: ${records.length}/${contexts.length} context(s), ` +
          `${records.reduce((sum, r) => sum + r.tiles.length, 0)} tile(s) → ${out.review}`,
        failures.length > 0 ? "warn" : "info",
      );
      if (manifest.retention) {
        emit.log(
          manifest.retention.managed
            ? `expires: ${manifest.retention.expires_at} (the whole pack is deleted; --retain to extend)`
            : `expires: ${manifest.retention.expires_at} (unmanaged: never deleted automatically)`,
          "info",
        );
      }
      emit.log(`judge: ${judgeCommandFor(packDir)}`, "info");
      if (opts.json) emit.data(manifest as unknown as Record<string, unknown>);
      if (failures.length > 0) process.exitCode = 4;
    });

  root
    .command("judge <dir>")
    .description(
      "Judge an existing pack from disk: every tile of every context through one bounded pool " +
        "of vision calls (no browser). Writes evidence/critique.json and refreshes review.md and " +
        "the inspection plan with the machine findings. Exit 2 on a high-severity finding, 4 when " +
        "no provider judged.",
    )
    .option(
      "--pool <n>",
      "Vision calls in flight across the pack (1-16; default: the provider's own).",
    )
    .option(
      "--allow-metered",
      "Permit the provider's metered-API fallback. Default: subscription-backed headless " +
        "harnesses only.",
    )
    .option(
      "--context <id>",
      "Judge only this context id (repeatable; default every context in the pack).",
      (value: string, previous: string[] = []) => [...previous, value],
      [] as string[],
    )
    .option(
      "--retain <minutes>",
      `Minutes the pack lives after this judge finishes (1-43200; default ` +
        `${PAGE_REVIEW_DEFAULT_RETENTION_MINUTES}). Whether the pack is managed is kept from ` +
        "its manifest.",
    )
    .option("--json", "Print the judge result as JSON.")
    .action(async (dir: string, opts: JudgeOpts) => {
      const packDir = resolve(dir);
      const retainMinutes = parseRetainMinutes(opts.retain);
      if (typeof retainMinutes !== "number") {
        emit.error({ code: "review_pack_invalid_retain", message: retainMinutes.error });
        process.exitCode = 1;
        return;
      }
      let manifest: ReturnType<typeof readPackManifest>;
      try {
        manifest = readPackManifest(packDir);
      } catch (err: unknown) {
        emit.error({
          code: "review_pack_unreadable",
          message: `not a page review pack: ${err instanceof Error ? err.message : String(err)}`,
        });
        process.exitCode = 1;
        return;
      }
      let pool: number | undefined;
      if (opts.pool !== undefined) {
        const n = Number.parseInt(opts.pool, 10);
        if (!Number.isInteger(n) || n < 1 || n > 16) {
          emit.error({
            code: "review_pack_invalid_pool",
            message: "--pool must be an integer between 1 and 16",
          });
          process.exitCode = 1;
          return;
        }
        pool = n;
      }
      const available = listPackContexts(packDir);
      const wanted = opts.context?.length ? opts.context : available;
      const missing = wanted.filter((id) => !available.includes(id));
      if (missing.length > 0) {
        emit.error({
          code: "review_pack_unknown_context",
          message: `context(s) not in the pack: ${missing.join(", ")} (have: ${available.join(", ") || "none"})`,
        });
        process.exitCode = 1;
        return;
      }
      const prior = process.env[QA_RUN_HEADLESS_ONLY_ENV];
      if (!opts.allowMetered) process.env[QA_RUN_HEADLESS_ONLY_ENV] = "1";
      let provider: Awaited<
        ReturnType<NonNullable<HarneryProgramContext["critiqueProviderLoader"]>>
      >;
      try {
        provider = context?.critiqueProvider ?? (await context?.critiqueProviderLoader?.());
      } catch (err: unknown) {
        provider = undefined;
        emit.log(
          `critique provider failed to load: ${err instanceof Error ? err.message : String(err)}`,
          "warn",
        );
      }
      const result = await judgePageReviewPack({
        packDir,
        provider,
        rubric: DEFAULT_CRITIQUE_RUBRIC,
        ...(pool !== undefined ? { concurrency: pool } : {}),
        contextIds: wanted,
        onLog: (message) => emit.log(message, "info"),
      });
      if (prior === undefined) delete process.env[QA_RUN_HEADLESS_ONLY_ENV];
      else process.env[QA_RUN_HEADLESS_ONLY_ENV] = prior;

      const merged = new Map((manifest.critique ?? []).map((row) => [row.context_id, row]));
      for (const row of toCritiqueRecords(result)) merged.set(row.context_id, row);
      finalizePageReviewPack({
        packDir,
        target: manifest.target,
        ...(manifest.tested_revision !== undefined
          ? { tested_revision: manifest.tested_revision }
          : {}),
        contexts: manifest.contexts,
        gates: manifest.gates,
        critique: [...merged.values()],
        pool: result.pool,
        warnings: manifest.warnings.filter((w) => !w.includes("tile cap reached")),
        createdAt: manifest.created_at,
        judgeCommand: judgeCommandFor(packDir),
        // The judge's finish time starts the retention clock; a pack whose
        // manifest never said it was managed stays unmanaged.
        retention: retentionFromNow(retainMinutes, manifest.retention?.managed === true),
      });
      for (const row of result.contexts) {
        const high = row.findings.filter((f) => f.severity === "high").length;
        emit.log(
          `${row.context_id}: ${row.outcome.toUpperCase()} · ${row.tiles_reviewed}/${row.tiles_total} tiles judged` +
            (row.tiles_reused > 0 ? `, ${row.tiles_reused} reused` : "") +
            ` · ${high} high / ${row.findings.length - high} other finding(s)` +
            (row.error ? ` · ${row.error}` : ""),
          row.outcome === "pass" ? "info" : "warn",
        );
      }
      emit.log(
        `judge: ${result.outcome} · pool ${result.pool.concurrency} · ${result.tiles_reviewed} tile(s) in ${result.pool.wall_time_ms}ms · ${packPaths(packDir).review}`,
        result.outcome === "pass" ? "info" : "warn",
      );
      if (opts.json) emit.data(result as unknown as Record<string, unknown>);
      if (result.outcome === "fail") process.exitCode = 2;
      else if (result.outcome !== "pass") process.exitCode = 4;
    });

  root
    .command("expand <dir>")
    .description(
      "Re-capture ONE tile region of an existing pack at a higher device scale factor: the " +
        "same target and context are rendered again through a child browse, the tile's rect " +
        "is cropped at that DPR into contexts/<id>/tiles/<tile>@<dpr>x.png, the context record " +
        "gains an `expanded` entry, and review.md is refreshed. Existing tiles are never touched.",
    )
    .requiredOption("--tile <id>", "Tile id to expand (e.g. T012).")
    .option(
      "--context <id>",
      "Context the tile belongs to. Required when more than one context carries that tile id.",
    )
    .option("--dpr <n>", "Device scale factor for the re-capture (1-4; default 2).", "2")
    .option("--timeout <ms>", "Capture timeout in milliseconds (default 120000).", "120000")
    .option("--json", "Print the expanded tile record as JSON.")
    .action(async (dir: string, opts: ExpandOpts) => {
      const packDir = resolve(dir);
      let manifest: ReturnType<typeof readPackManifest>;
      try {
        manifest = readPackManifest(packDir);
      } catch (err: unknown) {
        emit.error({
          code: "review_pack_unreadable",
          message: `not a page review pack: ${err instanceof Error ? err.message : String(err)}`,
        });
        process.exitCode = 1;
        return;
      }
      const dpr = Number.parseFloat(opts.dpr ?? "2");
      if (!Number.isFinite(dpr) || dpr < 1 || dpr > 4) {
        emit.error({
          code: "review_pack_invalid_dpr",
          message: "--dpr must be a number between 1 and 4",
        });
        process.exitCode = 1;
        return;
      }
      const tileId = (opts.tile ?? "").trim();
      let located: ReturnType<typeof findPackTile>;
      try {
        located = findPackTile(manifest.contexts, tileId, opts.context);
      } catch (err: unknown) {
        emit.error({
          code: "review_pack_unknown_tile",
          message: err instanceof Error ? err.message : String(err),
        });
        process.exitCode = 1;
        return;
      }
      const ctx = located.context;
      const cliScript = process.argv[1];
      if (!cliScript) {
        emit.error({
          code: "review_pack_no_cli_script",
          message: "cannot resolve the host CLI script path for the child browse invocation",
        });
        process.exitCode = 1;
        return;
      }
      const timeoutMs = Math.max(1000, Number.parseInt(opts.timeout ?? "120000", 10) || 120_000);
      // Same render inputs as the original capture: target, viewport, color
      // scheme, theme and state labels. Only the DPR differs.
      const argv = [
        process.execPath,
        cliScript,
        "browse",
        manifest.target,
        "--viewport",
        ctx.viewport,
        ...(ctx.theme === "dark" ? ["--color-scheme", "dark"] : []),
        "--out",
        resolve(packDir, "..", `${ctx.id}-expand-${tileId}`),
        "--no-screenshot",
        "--review-pack",
        packDir,
        "--review-pack-context",
        ctx.id,
        "--review-pack-expand",
        tileId,
        "--device-scale-factor",
        String(dpr),
        "--qa-theme",
        ctx.theme,
        "--qa-state",
        ctx.state,
      ];
      emit.log(`expand ${ctx.id}/${tileId} at ${dpr}× from ${manifest.target}`, "info");
      const res = await defaultQaRunExec(argv, { timeoutMs, env: { ...process.env } });
      if (res.error || res.exitCode !== 0) {
        const tail = (res.stderr || res.stdout).trim().split("\n").slice(-3).join(" ");
        emit.error({
          code: "review_pack_expand_failed",
          message:
            `re-capture of ${ctx.id}/${tileId} did not complete: ` +
            (res.error ?? `exit code ${res.exitCode}${tail ? `: ${tail}` : ""}`),
        });
        process.exitCode = 4;
        return;
      }
      let updated: PageReviewContextRecord;
      try {
        updated = readPackContext(packDir, ctx.id);
      } catch (err: unknown) {
        emit.error({
          code: "review_pack_expand_failed",
          message: `pack context unreadable after expand: ${err instanceof Error ? err.message : String(err)}`,
        });
        process.exitCode = 4;
        return;
      }
      const expanded = updated.expanded?.find(
        (entry) => entry.tile === tileId && entry.dpr === dpr,
      );
      if (!expanded) {
        emit.error({
          code: "review_pack_expand_failed",
          message: `the child browse exited 0 but ${ctx.id} carries no expanded record for ${tileId} at ${dpr}×`,
        });
        process.exitCode = 4;
        return;
      }
      finalizePageReviewPack({
        packDir,
        target: manifest.target,
        ...(manifest.tested_revision !== undefined
          ? { tested_revision: manifest.tested_revision }
          : {}),
        contexts: manifest.contexts.map((entry) => (entry.id === ctx.id ? updated : entry)),
        gates: manifest.gates,
        critique: manifest.critique,
        ...(manifest.pool ? { pool: manifest.pool } : {}),
        warnings: manifest.warnings.filter((w) => !w.includes("tile cap reached")),
        createdAt: manifest.created_at,
        judgeCommand: judgeCommandFor(packDir),
      });
      emit.log(
        `expanded ${ctx.id}/${tileId} at ${dpr}× → ${expanded.width}×${expanded.height} px · ` +
          `${expandedTileFilename(tileId, dpr)} · ${packPaths(packDir).review}`,
        "info",
      );
      if (opts.json) emit.data(expanded as unknown as Record<string, unknown>);
    });

  root
    .command("clean")
    .description(
      "Delete expired page review packs. Previews by default; --yes deletes. A pack is " +
        "eligible once its manifest's retention.expires_at has passed and it was written to " +
        "the managed artifact store (managed: true); --include-unmanaged also takes packs " +
        "written to an explicit --out. Every deleted pack leaves a pack-expired.json stub.",
    )
    .option(
      "--root <dir>",
      "Directory to search: the root itself, each child workspace, and run-*/pack beneath " +
        "them (default: the project's .harnery/artifacts store).",
    )
    .option("--yes", "Delete. Without it, only report what would be deleted.")
    .option("--include-unmanaged", "Also delete expired packs whose manifest says managed: false.")
    .option("--json", "Print every pack found and the deleted set as JSON.")
    .action((opts: CleanOpts) => {
      const searchRoot =
        opts.root !== undefined ? resolve(opts.root) : artifactsRoot(resolveQaRepoRoot(context));
      const includeUnmanaged = opts.includeUnmanaged === true;
      const dryRun = opts.yes !== true;
      let result: ReturnType<typeof deleteExpiredPacks>;
      try {
        result = deleteExpiredPacks({ roots: [searchRoot], includeUnmanaged, dryRun });
      } catch (err: unknown) {
        emit.error({
          code: "review_pack_clean_failed",
          message: `expired pack sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        process.exitCode = 1;
        return;
      }
      if (opts.json) {
        emit.data({
          root: searchRoot,
          dry_run: dryRun,
          include_unmanaged: includeUnmanaged,
          candidates: result.candidates,
          deleted: result.deleted,
        });
        return;
      }
      if (result.candidates.length === 0) {
        emit.log(`no page review packs under ${searchRoot}`, "info");
        return;
      }
      for (const row of result.candidates) emit.log(packRowLine(row, includeUnmanaged), "info");
      const n = result.deleted.length;
      const packs = `${n} pack${n === 1 ? "" : "s"}`;
      if (dryRun) {
        emit.log(
          n > 0
            ? `would delete ${packs}; rerun with --yes to delete` +
                (includeUnmanaged ? "" : " (--include-unmanaged for explicit --out packs)")
            : "nothing to delete",
          "info",
        );
      } else {
        emit.log(`deleted ${packs}; each left a pack-expired.json stub`, n > 0 ? "info" : "debug");
      }
    });

  root
    .command("list")
    .description(
      "List every page review pack under the artifact store (or --root): age, size, contexts, " +
        "tiles, machine outcome, reviewed outcome when a verdict exists, and expiry.",
    )
    .option(
      "--root <dir>",
      "Directory to search (default: the project's .harnery/artifacts store).",
    )
    .option("--json", "Print the rows as JSON.")
    .action((opts: ListOpts) => {
      const searchRoot =
        opts.root !== undefined ? resolve(opts.root) : artifactsRoot(resolveQaRepoRoot(context));
      const nowMs = Date.now();
      const rows: PackListRow[] = [];
      for (const dir of findPageReviewPacks([searchRoot])) {
        try {
          rows.push(packListRow(dir, readPackManifest(dir), readPackVerdict(dir), nowMs));
        } catch (err: unknown) {
          emit.log(
            `${dir}: manifest unreadable (${err instanceof Error ? err.message : String(err)})`,
            "warn",
          );
        }
      }
      if (opts.json) {
        emit.data({ root: searchRoot, packs: rows });
        return;
      }
      if (rows.length === 0) {
        emit.log(`no page review packs under ${searchRoot}`, "info");
        return;
      }
      emit.log(
        `${"age".padStart(6)} ${"size".padStart(9)} ${"ctx".padStart(3)} ${"tiles".padStart(5)} ` +
          `${"machine".padEnd(10)} ${"reviewed".padEnd(10)} ${"expiry".padEnd(26)} pack`,
        "info",
      );
      for (const row of rows) emit.log(packListLine(row), "info");
    });

  root
    .command("show <dir>")
    .description(
      "Summarize one pack from manifest.json: target, expiry, size, and a context table with " +
        "tiles, hit bands, coverage, capture source, and finding counts. Read review.md for the " +
        "tiles themselves.",
    )
    .option("--json", "Print the summary as JSON.")
    .action((dir: string, opts: { json?: boolean }) => {
      const packDir = resolve(dir);
      let manifest: ReturnType<typeof readPackManifest>;
      try {
        manifest = readPackManifest(packDir);
      } catch (err: unknown) {
        emit.error({
          code: "review_pack_not_found",
          message: `${packDir}: not a page review pack (${err instanceof Error ? err.message : String(err)})`,
        });
        process.exitCode = 1;
        return;
      }
      const verdict = readPackVerdict(packDir);
      const critiqueById = new Map((manifest.critique ?? []).map((row) => [row.context_id, row]));
      const contexts = manifest.contexts.map((ctx) => {
        const critique = critiqueById.get(ctx.id);
        const findings = critique?.findings ?? [];
        return {
          id: ctx.id,
          viewport: ctx.viewport,
          theme: ctx.theme,
          state: ctx.state,
          page: ctx.page,
          tiles: ctx.tiles.length,
          hit_bands: ctx.hit_bands ?? 0,
          coverage: ctx.coverage,
          capture_source: ctx.capture_fidelity?.source ?? "full-page",
          machine_outcome: critique?.outcome ?? null,
          high: findings.filter((f) => f.severity === "high").length,
          medium: findings.filter((f) => f.severity === "medium").length,
          low: findings.filter((f) => f.severity === "low").length,
        };
      });
      const summary = {
        dir: packDir,
        target: manifest.target,
        tested_revision: manifest.tested_revision ?? null,
        created_at: manifest.created_at,
        expires_at: manifest.retention?.expires_at ?? null,
        managed: manifest.retention?.managed ?? null,
        size_bytes: manifest.size_bytes ?? null,
        machine_outcome: aggregateMachineOutcome(manifest.critique),
        reviewed_outcome: verdict?.reviewed_outcome ?? null,
        warnings: manifest.warnings,
        contexts,
        review: resolve(packDir, manifest.files.review),
      };
      if (opts.json) {
        emit.data(summary);
        return;
      }
      emit.log(`pack: ${packDir}`, "info");
      emit.log(`target: ${manifest.target}`, "info");
      emit.log(
        `created ${manifest.created_at}; expires ${summary.expires_at ?? "never (no retention)"}` +
          `${summary.managed === false ? " (unmanaged)" : ""}; ${formatBytes(summary.size_bytes)}`,
        "info",
      );
      emit.log(
        `machine outcome: ${summary.machine_outcome ?? "not judged"}; reviewed outcome: ${summary.reviewed_outcome ?? "no verdict"}`,
        "info",
      );
      for (const ctx of contexts) {
        const cov = `${ctx.coverage.bands_reviewed}/${ctx.coverage.bands_total} bands${ctx.coverage.capped ? ", capped" : ""}`;
        emit.log(
          `  ${ctx.id.padEnd(24)} ${ctx.page.width}×${ctx.page.height} px  ${String(ctx.tiles).padStart(3)} tiles` +
            `${ctx.hit_bands > 0 ? ` (+${ctx.hit_bands} hit)` : ""}  ${cov}  ${ctx.capture_source}  ` +
            `${ctx.machine_outcome ?? "not judged"} ${ctx.high}h/${ctx.medium}m/${ctx.low}l`,
          "info",
        );
      }
      for (const warning of manifest.warnings) emit.log(`  warning: ${warning}`, "warn");
      emit.log(`review: ${summary.review}`, "info");
    });

  const reviews = root
    .command("reviews")
    .description("Record delegated review-subagent coverage for primary tiles.");

  reviews
    .command("add <dir>")
    .description(
      "Record one review subagent's assigned and completed primary tiles. Re-running with " +
        "the same reviewer replaces that reviewer's record.",
    )
    .requiredOption("--reviewer <id>", "Review subagent name or stable id.")
    .requiredOption("--model <name>", `Subagent model: ${PAGE_REVIEW_SUBAGENT_MODELS.join(", ")}.`)
    .requiredOption(
      "--assigned <context/tile>",
      "Assigned primary tile, e.g. desktop-light-default/T012 (repeatable).",
      (value: string, previous: string[] = []) => [...previous, value],
      [] as string[],
    )
    .option(
      "--completed <context/tile>",
      "Assigned tile opened at native pixels (repeatable).",
      (value: string, previous: string[] = []) => [...previous, value],
      [] as string[],
    )
    .option("--status <status>", "complete or incomplete.", "complete")
    .option("--json", "Print the written delegated-review record as JSON.")
    .action((dir: string, opts: ReviewAddOpts) => {
      const pack = readReviewerPack(dir, emit);
      if (!pack) return;
      const { packDir, findings: doc } = pack;
      const plan = readPackInspectionPlan(packDir);
      const primary = new Set(
        plan.contexts.flatMap((context) =>
          context.primary_tiles.map((tile) => `${context.context_id}/${tile.id}`),
        ),
      );
      const assigned = [...new Set((opts.assigned ?? []).map((tile) => tile.trim()))].filter(
        Boolean,
      );
      const completed = [...new Set((opts.completed ?? []).map((tile) => tile.trim()))].filter(
        Boolean,
      );
      const unknown = assigned.filter((tile) => !primary.has(tile));
      if (unknown.length > 0) {
        emit.error({
          code: "review_pack_unknown_primary_tile",
          message: `assigned tile(s) are not primary tiles in the inspection plan: ${unknown.join(", ")}`,
        });
        process.exitCode = 1;
        return;
      }
      const record = {
        reviewer: opts.reviewer?.trim() ?? "",
        model: opts.model as (typeof PAGE_REVIEW_SUBAGENT_MODELS)[number],
        assigned_tiles: assigned,
        completed_tiles: completed,
        status: opts.status as "complete" | "incomplete",
      };
      const nextReviews = doc.delegated_reviews.filter(
        (entry) => entry.reviewer !== record.reviewer,
      );
      const reviewerNames = [
        ...new Set([...nextReviews.map((entry) => entry.reviewer), record.reviewer]),
      ];
      const next: PageReviewFindingsDocument = {
        ...doc,
        reviewer: reviewerNames.filter(Boolean).join(", ") || null,
        reviewed_at: new Date().toISOString(),
        delegated_reviews: [...nextReviews, record],
      };
      if (!commitFindings(packDir, next, emit)) return;
      emit.log(
        `${record.reviewer} · ${record.completed_tiles.length}/${record.assigned_tiles.length} assigned primary tiles · ${record.status}`,
        "info",
      );
      if (opts.json) emit.data(record as unknown as Record<string, unknown>);
    });

  const findings = root
    .command("findings")
    .description("Review-subagent findings serialized into the pack's findings.json.");

  findings
    .command("add <dir>")
    .description(
      "Append one review-subagent finding to findings.json. The document is validated against " +
        "findings.schema.json before the atomic write; every violation is printed at once. " +
        "Ids run F001, F002, ... unless --id is given.",
    )
    .requiredOption("--context <id>", "Context id the finding belongs to (see review.md).")
    .requiredOption(
      "--tile <id>",
      "Tile id the finding cites, e.g. T012 (repeatable; becomes the evidence list).",
      (value: string, previous: string[] = []) => [...previous, value],
      [] as string[],
    )
    .requiredOption("--severity <s>", `One of ${PAGE_REVIEW_FINDING_SEVERITIES.join(", ")}.`)
    .requiredOption("--category <c>", `One of ${PAGE_REVIEW_FINDING_CATEGORIES.join(", ")}.`)
    .requiredOption("--observation <text>", "What the tile shows, in one or two sentences.")
    .option("--recommendation <text>", "What should change.")
    .option("--id <id>", "Finding id (uppercase letters, digits, _ or -; default next F###).")
    .option("--reviewer <name>", "Sets the document's top-level reviewer.")
    .option("--json", "Print the written finding as JSON.")
    .action((dir: string, opts: FindingsAddOpts) => {
      const pack = readReviewerPack(dir, emit);
      if (!pack) return;
      const { packDir, manifest, findings: doc } = pack;
      const contextId = opts.context ?? "";
      const ctx = manifest.contexts.find((c) => c.id === contextId);
      if (!ctx) {
        emit.error({
          code: "review_pack_unknown_context",
          message: `context ${JSON.stringify(contextId)} is not in the pack (have: ${manifest.contexts.map((c) => c.id).join(", ") || "none"})`,
        });
        process.exitCode = 1;
        return;
      }
      const tileIds = (opts.tile ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
      const unknownTiles = tileIds.filter((id) => !ctx.tiles.some((t) => t.id === id));
      if (unknownTiles.length > 0) {
        emit.error({
          code: "review_pack_unknown_tile",
          message: `tile(s) not in ${ctx.id}: ${unknownTiles.join(", ")}`,
        });
        process.exitCode = 1;
        return;
      }
      const id = (opts.id ?? "").trim() || nextFindingId(doc.findings);
      if (doc.findings.some((f) => f.id === id)) {
        emit.error({
          code: "review_pack_duplicate_finding",
          message: `finding id ${id} already exists in findings.json`,
        });
        process.exitCode = 1;
        return;
      }
      const finding = {
        id,
        severity: (opts.severity ?? "") as PageReviewFindingSeverity,
        category: (opts.category ?? "") as PageReviewFindingCategory,
        context_id: ctx.id,
        evidence: tileIds,
        observation: opts.observation ?? "",
        ...(opts.recommendation !== undefined ? { recommendation: opts.recommendation } : {}),
      };
      const next: PageReviewFindingsDocument = {
        ...doc,
        reviewer: opts.reviewer ?? doc.reviewer,
        reviewed_at: new Date().toISOString(),
        findings: [...doc.findings, finding],
      };
      if (!commitFindings(packDir, next, emit)) return;
      emit.log(
        `${id} · ${finding.severity} · ${finding.category} · ${ctx.id}/${tileIds.join(",")} → ${packPaths(packDir).findings}`,
        "info",
      );
      if (opts.json) emit.data(finding as unknown as Record<string, unknown>);
    });

  root
    .command("disposition <dir> <target> <disposition>")
    .description(
      "Record the reviewer's verdict on one machine finding. <target> is " +
        "<context-id>/<tile-id>#<n>, n the finding's 0-based position among that tile's " +
        `findings in evidence/critique.json; <disposition> is one of ${PAGE_REVIEW_DISPOSITIONS.join(", ")}. ` +
        "A target that names no machine finding is refused; a prior disposition of the same " +
        "target is replaced. evidence/critique.json itself is never rewritten.",
    )
    .option("--note <text>", "Why; what the tile actually shows.")
    .option("--by <name>", "Who dispositioned it.")
    .option("--json", "Print the written disposition as JSON.")
    .action((dir: string, target: string, disposition: string, opts: DispositionOpts) => {
      const pack = readReviewerPack(dir, emit);
      if (!pack) return;
      const { packDir, manifest, findings: doc } = pack;
      if (!(PAGE_REVIEW_DISPOSITIONS as readonly string[]).includes(disposition)) {
        emit.error({
          code: "review_pack_invalid_disposition",
          message: `disposition must be one of ${PAGE_REVIEW_DISPOSITIONS.join(", ")} (got ${JSON.stringify(disposition)})`,
        });
        process.exitCode = 1;
        return;
      }
      if (manifest.critique === null) {
        emit.error({
          code: "review_pack_not_judged",
          message: `the judge has not run for this pack, so there is no machine finding to disposition; run: ${judgeCommandFor(packDir)}`,
        });
        process.exitCode = 1;
        return;
      }
      const targets = machineFindingTargets(manifest.critique);
      const machine = targets.get(target.trim());
      if (!machine) {
        const sample = [...targets.keys()].slice(0, 8).join(", ");
        emit.error({
          code: "review_pack_unknown_finding",
          message:
            `${JSON.stringify(target)} names no machine finding in evidence/critique.json` +
            (sample ? ` (known targets include: ${sample})` : " (the critique holds no findings)"),
        });
        process.exitCode = 1;
        return;
      }
      const entry = {
        target: target.trim(),
        disposition: disposition as PageReviewDisposition,
        ...(opts.note !== undefined ? { note: opts.note } : {}),
        ...(opts.by !== undefined ? { by: opts.by } : {}),
        at: new Date().toISOString(),
      };
      const kept = (doc.dispositions ?? []).filter((d) => d.target !== entry.target);
      const next: PageReviewFindingsDocument = {
        ...doc,
        reviewed_at: new Date().toISOString(),
        dispositions: [...kept, entry],
      };
      if (!commitFindings(packDir, next, emit)) return;
      emit.log(
        `${entry.target} · ${machine.severity} · ${machine.category} → ${entry.disposition}` +
          (kept.length < (doc.dispositions ?? []).length ? " (replaced)" : ""),
        "info",
      );
      if (opts.json) emit.data(entry as unknown as Record<string, unknown>);
    });

  root
    .command("verdict <dir>")
    .description(
      "Combine the machine critique with the reviewer's dispositions and findings into one " +
        "reviewed outcome: a machine high counts unless dispositioned artifact, not-a-defect, " +
        "or duplicate-of-gate; a review-subagent finding at high or critical counts. Every " +
        "primary tile also needs completed delegated-review coverage. Writes evidence/verdict.json " +
        "and refreshes review.md. Exit 2 on fail, 4 when critique or delegated coverage is " +
        "skipped or incomplete, 1 on a findings.json validation error.",
    )
    .option("--json", "Print the verdict as JSON.")
    .action((dir: string, opts: VerdictOpts) => {
      const pack = readReviewerPack(dir, emit);
      if (!pack) return;
      const { packDir, manifest, findings: doc } = pack;
      const errors = validateFindingsDocument(doc);
      if (errors.length > 0) {
        for (const error of errors) emit.log(`findings.json: ${error}`, "error");
        emit.error({
          code: "review_pack_findings_invalid",
          message: `${errors.length} validation error(s) in findings.json; fix them before a verdict`,
        });
        process.exitCode = 1;
        return;
      }
      const verdict: PageReviewVerdictDocument = {
        schema: PAGE_REVIEW_VERDICT_SCHEMA,
        ...resolvePackVerdict(manifest, readPackInspectionPlan(packDir), doc),
        reviewed_at: new Date().toISOString(),
      };
      const paths = packPaths(packDir);
      mkdirSync(paths.evidenceDir, { recursive: true });
      writeFileSync(paths.verdict, `${JSON.stringify(verdict, null, 2)}\n`);
      refreshPackFromManifest(packDir, manifest);
      for (const target of verdict.unmatched_dispositions) {
        emit.log(`disposition ${target} names no machine finding; ignored`, "warn");
      }
      emit.log(
        `reviewed ${verdict.reviewed_outcome.toUpperCase()} · machine ${verdict.machine_outcome} · ` +
          `highs ${verdict.high_total}: ${verdict.high_confirmed} confirmed, ${verdict.high_dismissed} dismissed, ${verdict.high_open} open · ` +
          `reviewer high/critical ${verdict.reviewer_high} · delegated tiles ${verdict.primary_tiles_reviewed}/${verdict.primary_tiles_total} · ${paths.verdict}`,
        verdict.reviewed_outcome === "pass" ? "info" : "warn",
      );
      if (opts.json) emit.data(verdict as unknown as Record<string, unknown>);
      if (verdict.reviewed_outcome === "fail") process.exitCode = 2;
      else if (verdict.reviewed_outcome !== "pass") process.exitCode = 4;
    });
}
