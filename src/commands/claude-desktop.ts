import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import {
  applyMirror,
  type DesktopAccount,
  findDesktopDataDirs,
  listAccounts,
  planMirror,
  readCliAccount,
} from "../lib/claude-desktop.ts";

/**
 * `claude-desktop`: make Claude desktop-app sessions survive account
 * switches.
 *
 * The desktop app scopes its Claude Code session sidebar per signed-in
 * account (plain JSON entry files under
 * `<dataDir>/claude-code-sessions/<account-uuid>/<env-id>/`), while the
 * transcripts live account-agnostically under `~/.claude/projects/`. A user
 * who hops accounts (e.g. when one hits its usage limit) loses sidebar
 * access to every session the other account created — even though the data
 * is all still on disk. `mirror` copies the entry files across account
 * directories so each account's sidebar lists the union; restarting the
 * desktop app picks the copies up, and opening one resumes with full
 * history.
 */
export function registerClaudeDesktopCommand(program: Command, emit: EmitContext): void {
  const cmd = program
    .command("claude-desktop")
    .description(
      "Claude desktop-app session index: list accounts/sessions, mirror sessions across accounts",
    )
    .action(() => {
      const dirs = requireDataDirs(emit, undefined);
      for (const dir of dirs) {
        emit.data({
          data_dir: dir,
          accounts: listAccounts(dir).map((a) => accountSummary(a)),
          cli_account: readCliAccount(),
        });
      }
    });

  cmd
    .command("accounts")
    .description("List account directories + session counts (labels the CLI's account when known)")
    .option("--data-dir <path>", "Explicit desktop-app data directory")
    .action((opts: { dataDir?: string }) => {
      const dirs = requireDataDirs(emit, opts.dataDir);
      const cli = readCliAccount();
      emit.data(
        dirs.map((dir) => ({
          data_dir: dir,
          accounts: listAccounts(dir).map((a) => ({
            ...accountSummary(a),
            is_cli_account: cli !== null && a.accountUuid === cli.accountUuid,
            cli_email: cli !== null && a.accountUuid === cli.accountUuid ? cli.email : null,
          })),
        })),
      );
    });

  cmd
    .command("sessions")
    .description("List session entries across every account (newest activity first)")
    .option("--data-dir <path>", "Explicit desktop-app data directory")
    .option("--account <uuid-prefix>", "Only this account (uuid prefix match)")
    .option("--archived", "Include archived entries")
    .action((opts: { dataDir?: string; account?: string; archived?: boolean }) => {
      const dirs = requireDataDirs(emit, opts.dataDir);
      const rows = [];
      for (const dir of dirs) {
        for (const account of listAccounts(dir)) {
          if (opts.account && !account.accountUuid.startsWith(opts.account)) continue;
          for (const e of account.entries) {
            if (e.isArchived && !opts.archived) continue;
            rows.push({
              account_uuid: account.accountUuid,
              cli_session_id: e.cliSessionId,
              title: e.title,
              cwd: e.cwd,
              model: e.model,
              archived: e.isArchived,
              last_activity_at: e.lastActivityAt,
            });
          }
        }
      }
      rows.sort((a, b) => (b.last_activity_at ?? 0) - (a.last_activity_at ?? 0));
      emit.data(rows);
    });

  cmd
    .command("mirror")
    .description(
      "Copy session entries across accounts so each sidebar lists the union. " +
        "Dry-run by default; --yes applies. Restart the desktop app afterward to pick up copies.",
    )
    .option("--data-dir <path>", "Explicit desktop-app data directory")
    .option(
      "--session <id-or-title>",
      "Only sessions matching this cliSessionId or title substring (repeatable)",
      collect,
      [] as string[],
    )
    .option("--all", "Mirror every (non-archived) session")
    .option(
      "--to <uuid-prefix>",
      "Only copy INTO accounts matching this prefix (repeatable)",
      collect,
      [] as string[],
    )
    .option(
      "--from <uuid-prefix>",
      "Only copy FROM accounts matching this prefix (repeatable)",
      collect,
      [] as string[],
    )
    .option("--include-archived", "Also mirror archived entries")
    .option("--yes", "Apply the plan (default is dry-run)")
    .action(
      (opts: {
        dataDir?: string;
        session: string[];
        all?: boolean;
        to: string[];
        from: string[];
        includeArchived?: boolean;
        yes?: boolean;
      }) => {
        if (!opts.all && opts.session.length === 0) {
          emit.error({
            code: "no_selection",
            message: "pass --session <id-or-title> (repeatable) or --all",
          });
          process.exit(2);
        }
        const dirs = requireDataDirs(emit, opts.dataDir);
        for (const dir of dirs) {
          const accounts = listAccounts(dir);
          if (accounts.length < 2) {
            emit.error({
              code: "single_account",
              message: `only ${accounts.length} account dir(s) under ${dir} — nothing to mirror across`,
            });
            process.exit(2);
          }
          const plan = planMirror(accounts, {
            to: opts.to,
            from: opts.from,
            sessions: opts.all ? undefined : opts.session,
            includeArchived: opts.includeArchived,
          });
          const planned = plan.actions.map((a) => ({
            title: a.entry.title,
            cli_session_id: a.entry.cliSessionId,
            to_account: a.targetAccountUuid,
            to_file: a.to,
          }));
          if (!opts.yes) {
            emit.data({
              data_dir: dir,
              dry_run: true,
              planned,
              skipped_existing: plan.skippedExisting,
              skipped_archived: plan.skippedArchived,
              hint: plan.actions.length > 0 ? "re-run with --yes to apply" : "nothing to copy",
            });
            continue;
          }
          const { copied } = applyMirror(plan);
          emit.data({
            data_dir: dir,
            dry_run: false,
            copied,
            planned,
            skipped_existing: plan.skippedExisting,
            skipped_archived: plan.skippedArchived,
            hint:
              copied > 0
                ? "fully quit the Claude desktop app (tray icon, not the X) and relaunch to see the sessions"
                : "nothing to copy",
          });
        }
      },
    );
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function accountSummary(a: DesktopAccount) {
  return {
    account_uuid: a.accountUuid,
    sessions: a.entries.length,
    archived: a.entries.filter((e) => e.isArchived).length,
    latest_title: a.entries[0]?.title ?? null,
    latest_activity_at: a.entries[0]?.lastActivityAt ?? null,
  };
}

function requireDataDirs(emit: EmitContext, explicit: string | undefined): string[] {
  const dirs = findDesktopDataDirs(explicit);
  if (dirs.length === 0) {
    emit.error({
      code: "not_found",
      message:
        "no Claude desktop-app data directory with a claude-code-sessions/ index found " +
        "(is the desktop app installed? pass --data-dir or set HARNERY_CLAUDE_DESKTOP_DIR)",
    });
    process.exit(2);
  }
  return dirs;
}
