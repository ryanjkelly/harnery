/**
 * `<bin> creds`: a Commander builder over the credential engine, so every host
 * offers the same pull, check, heal, and verify subcommands and output.
 */

import type { Command } from "commander";
import { type CredsEngine, CredsTargetError, OpMissingError } from "./engine.ts";

/**
 * Output methods the builder calls. `data`, `error` and `setExitCode` match a
 * host's Harnery `EmitContext`; `rows` and `progress` are optional richer
 * renderers (a table with chosen columns and a hint, and a progress line).
 */
export interface CredsCommandIO {
  data(payload: unknown): void;
  error(err: { code: string; message: string; hint?: string }): void;
  setExitCode(n: number): void;
  rows?(rows: Record<string, unknown>[], columns?: string[], opts?: { hint?: string }): void;
  progress?(message: string): void;
}

export interface CredsCommandOptions {
  engine: CredsEngine;
  io: CredsCommandIO;
  /** Extra fields merged into heal's report, such as a forwarding-helper notice. */
  healExtras?: () => Record<string, unknown> | undefined;
  /** Environment variables consulted, in order, when `verify --account` is absent. Default `["OP_ACCOUNT"]`. */
  accountEnv?: string[];
}

const OP_INSTALL_HINT = "Install: https://developer.1password.com/docs/cli/get-started/";

/** Register `creds` on `program` and return it, so a host can add its own subcommands. */
export function registerCredsCommand(program: Command, options: CredsCommandOptions): Command {
  const { engine, io } = options;
  const bin = engine.config.binName;
  const accountEnv = options.accountEnv ?? ["OP_ACCOUNT"];
  const progress = (message: string) => io.progress?.(message);

  const failWith = (err: unknown): void => {
    if (err instanceof CredsTargetError) {
      io.error({
        code: "no_scripts",
        message: err.message,
        hint: `Known keys: ${err.known.join(", ")}.`,
      });
    } else if (err instanceof OpMissingError) {
      io.error({ code: "op_cli_missing", message: err.message, hint: OP_INSTALL_HINT });
    } else {
      io.error({ code: "creds_error", message: err instanceof Error ? err.message : String(err) });
    }
    io.setExitCode(1);
  };

  const creds = program.command("creds").description("Credential management (1Password)");

  creds
    .command("pull [target]")
    .description(
      "Ensure credentials exist locally, pulling only missing ones from 1Password. Target is a credential key " +
        "or a repository name; no target ensures everything. Use --refresh to replace existing local copies.",
    )
    .option("--refresh", "Replace existing local credential files from 1Password")
    .action(async (target: string | undefined, opts: { refresh?: boolean }) => {
      try {
        const report = await engine.pull(target, opts);
        if (!report.contacted) {
          progress(
            `Reused ${report.counts.local} local credential ${report.counts.local === 1 ? "copy" : "copies"}; ` +
              "1Password was not contacted. Use --refresh to replace them.",
          );
        }
        io.data(report);
        if (report.contacted) {
          io.rows?.(report.results, ["script", "status", "description"], {
            hint: `${report.counts.ok} ok, ${report.counts.fail} fail, ${report.counts.local} local`,
          });
        }
        if (!report.ok) io.setExitCode(1);
      } catch (err) {
        failWith(err);
      }
    });

  creds
    .command("check")
    .description(
      "Check credential freshness and prove each one still authenticates with the host's probes. " +
        "Exits non-zero on a missing or dead credential. Use --mtime-only to skip probes.",
    )
    .option(
      "--mtime-only",
      "Skip probes and report file age only; a present but revoked secret still reads ok",
    )
    .option("--live", "Run probes (the default)")
    .action(async (opts: { mtimeOnly?: boolean }) => {
      try {
        const report = await engine.check({ live: !opts.mtimeOnly });
        if (report.mode === "mtime") {
          if (!io.rows) io.data(report);
          io.rows?.(report.rows, ["path", "status", "age_human"], {
            hint:
              `Run \`${bin} creds pull\` to fill missing files, or \`${bin} creds pull --refresh\` to replace ` +
              "existing copies. These statuses are file age only: a present but revoked secret still reads ok.",
          });
        } else {
          io.data(report);
          const hints = [
            `${report.counts.live} live, ${report.counts.dead} dead, ${report.counts.skipped} unprobed`,
          ];
          if (report.counts.dead > 0) {
            hints.push(
              "A dead credential is not a stale file. Read live_detail: an expired grant needs re-authorization, " +
                `which \`${bin} creds pull\` cannot fix because the 1Password copy is dead too.`,
            );
          }
          if (report.counts.skipped > 0)
            hints.push("`skipped` means unverified, not healthy: no probe is defined.");
          io.rows?.(report.rows, ["path", "status", "live", "live_detail"], {
            hint: hints.join("\n"),
          });
        }
        if (!report.ok) io.setExitCode(1);
      } catch (err) {
        failWith(err);
      }
    });

  creds
    .command("heal")
    .description(
      "Repair missing, empty or malformed credential files, and files behind their registry revision, by " +
        "running their pull scripts. Never repairs on age alone, and always exits 0.",
    )
    .option("--dry-run", "Report what would be pulled without running anything")
    .option("--force", "Retry failed pulls without waiting for the retry delay")
    .action(async (opts: { dryRun?: boolean; force?: boolean }) => {
      try {
        const report = await engine.heal(opts);
        io.data({ ...report, ...(options.healExtras?.() ?? {}) });
      } catch (err) {
        // Fail open: heal runs at session start, and a clone that cannot reach
        // 1Password must still get a usable session.
        io.data({
          ok: false,
          healed: 0,
          failed: 0,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

  creds
    .command("verify")
    .description(
      "Verify every item and field the pull scripts read still exists in 1Password, catching renames " +
        `before \`${bin} creds pull\` breaks.`,
    )
    .option("--account <account>", "1Password account")
    .action(async (opts: { account?: string }) => {
      try {
        const account = opts.account ?? accountEnv.map((n) => process.env[n]).find(Boolean);
        const report = await engine.verify(account);
        io.data(report);
        if (report.problems.length > 0) {
          const unreadable = report.problems.filter((r) => r.status === "unreadable").length;
          const resolved = report.problems.length - unreadable;
          const hints: string[] = [];
          if (resolved > 0) {
            hints.push(
              `${resolved} reference(s) no longer resolve in 1Password (account ${report.account ?? "default"}). ` +
                "Fix the item or field in 1Password, or update the registry if a rename was intentional.",
            );
          }
          if (unreadable > 0) {
            hints.push(
              `${unreadable} reference(s) could not be read after retries; this says nothing about whether they exist.`,
            );
          }
          io.rows?.(report.problems, ["vault", "item", "field", "status", "reason", "scripts"], {
            hint: hints.join(" "),
          });
          io.setExitCode(1);
        } else {
          progress(
            `All ${report.counts.fields} credential references across ${report.counts.items} items resolve in 1Password.`,
          );
        }
      } catch (err) {
        failWith(err);
      }
    });

  return creds;
}
