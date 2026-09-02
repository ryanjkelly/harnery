// `review-pack create <target>` / `review-pack judge <dir>`: build a page
// review pack (tiles, DOM, signature per rendering context, plus review.md)
// and judge one from disk through one bounded pool of vision calls. qa-run
// composes the same two library halves; this command exposes them directly
// so an agent can prepare a page for review, or review a pack, on its own.

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import { resolveBinName } from "../core/config.ts";
import { createManagedQaOutParent, resolveQaRepoRoot } from "../core/qa-artifacts.ts";
import { DEFAULT_CRITIQUE_RUBRIC } from "../lib/browser/critique.ts";
import { judgePageReviewPack, toCritiqueRecords } from "../lib/browser/page-review-judge.ts";
import {
  finalizePageReviewPack,
  listPackContexts,
  type PageReviewContextRecord,
  packPaths,
  readPackContext,
  readPackManifest,
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
  json?: boolean;
}

interface JudgeOpts {
  pool?: string;
  allowMetered?: boolean;
  context?: string[];
  json?: boolean;
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
    .option("--json", "Print the pack manifest as JSON.")
    .action(async (target: string, opts: CreateOpts) => {
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
      let packDir: string;
      try {
        packDir =
          opts.out !== undefined
            ? resolve(opts.out)
            : createManagedQaOutParent(resolveQaRepoRoot(context), "review-pack");
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
      });
      const manifest = readPackManifest(packDir);
      emit.log(
        `pack: ${records.length}/${contexts.length} context(s), ` +
          `${records.reduce((sum, r) => sum + r.tiles.length, 0)} tile(s) → ${out.review}`,
        failures.length > 0 ? "warn" : "info",
      );
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
    .option("--json", "Print the judge result as JSON.")
    .action(async (dir: string, opts: JudgeOpts) => {
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
}
