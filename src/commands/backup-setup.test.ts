import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { removeDir } from "../../tests/helpers/remove-dir.ts";
import { restoreProcessEnv } from "../../tests/helpers/restore-env.ts";
import type { EmitContext } from "../commander.ts";
import { inspectBackupSetup } from "../core/backup/setup.ts";
import { backupConfig } from "../core/config.ts";
import { planScheduledBackup, scheduleBackupSnapshot } from "../core/hooks/backup-schedule.ts";
import { registerBackupCommand } from "./backup.ts";

let root: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "harnery-backup-setup-"));
  process.env.PATH = join(root, "bin");
  process.env.RCLONE_CONFIG = join(root, "rclone.conf");
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.APPDATA = join(root, "appdata");
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("RCLONE_CONFIG_") || key.startsWith("HARNERY_RESTIC_")) {
      delete process.env[key];
    }
  }
  delete process.env.HARNERY_RESTIC_REPO;
  delete process.env.HARNERY_RESTIC_PASSWORD_FILE;
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, ".harnery", "logs"), { recursive: true });
});

afterEach(() => {
  restoreProcessEnv(savedEnv);
  removeDir(root);
});

const prerequisites = ["restic", "password", "rclone", "remote"] as const;

describe("backup machine setup", () => {
  test.each([
    ...prerequisites,
  ])("skips quietly with %s absent despite an old failure", (missing) => {
    configure(missing);
    writeFileSync(
      join(root, ".harnery", "logs", "backup-schedule.status.json"),
      JSON.stringify({ exit_code: 1, finished_at: "2026-01-02T12:00:00Z" }),
    );
    const plan = planScheduledBackup(root);
    expect(plan).toEqual({ action: "unconfigured", cue: null, invocation: null });
    expect(scheduleBackupSnapshot(root)).toEqual({ launched: false, cue: null });
    expect(existsSync(join(root, ".harnery", "logs", "backup-schedule.log"))).toBeFalse();
    const issue = inspectBackupSetup(backupConfig(root)).missing;
    expect(issue).toHaveLength(1);
    expect(issue[0]?.code).toBe(
      (
        {
          restic: "restic_missing",
          password: "backup_password_missing",
          rclone: "rclone_missing",
          remote: "rclone_remote_missing",
        } as const
      )[missing],
    );
  });

  test.each([
    ...prerequisites,
  ])("manual snapshots name the missing %s and fail", async (missing) => {
    configure(missing);
    for (const args of [[], ["--if-stale", "24h"]]) {
      const result = await snapshot(args);
      expect(result.exitCode).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toContain(
        {
          restic: "restic",
          password: join(root, "password"),
          rclone: "rclone",
          remote: '"archive"',
        }[missing],
      );
      expect(existsSync(join(root, ".harnery", "locks"))).toBeFalse();
      expect(existsSync(join(root, "executed-tool"))).toBeFalse();
    }
  });

  test("all configured prerequisites permit retrying an operational failure", () => {
    configure();
    writeFileSync(
      join(root, ".harnery", "logs", "backup-schedule.status.json"),
      JSON.stringify({ exit_code: 3, finished_at: "2026-01-02T12:00:00Z" }),
    );
    expect(inspectBackupSetup(backupConfig(root)).missing).toEqual([]);
    const plan = planScheduledBackup(root);
    expect(plan.action).toBe("launch");
    expect(plan.cue).toContain("failed (exit 3");
  });

  test("manual overrides are checked instead of the project's missing setup", async () => {
    configure("password");
    const result = await snapshot(["--password-file", join(root, "override-password")]);
    expect(result.exitCode).toBe(1);
    expect(result.errors[0]?.message).toContain("override-password");
    configure("remote");
    const local = await snapshot([
      "--repo",
      join(root, "repository"),
      "--password-file",
      join(root, "missing-password"),
    ]);
    expect(local.errors.map((issue) => issue.code)).toEqual(["backup_password_missing"]);
  });

  test.skipIf(process.platform === "win32")(
    "a configured manual run still reports restic failure",
    async () => {
      configure();
      writeFileSync(
        join(root, "bin", "restic"),
        `#!${process.execPath}\nprocess.stderr.write("fixture repository failure\\n"); process.exit(7);\n`,
      );
      const result = await snapshot(["--if-stale", "24h"]);
      expect(result.exitCode).toBe(7);
      expect(result.errors).toEqual([
        { code: "backup_snapshot_list_failed", message: "fixture repository failure" },
      ]);
    },
  );

  test("restoring local prerequisites resumes retry and preserves failure evidence", () => {
    configure("password");
    writeFileSync(
      join(root, ".harnery", "logs", "backup-schedule.status.json"),
      JSON.stringify({ exit_code: 7, finished_at: "2026-01-02T12:00:00Z" }),
    );
    expect(planScheduledBackup(root).action).toBe("unconfigured");
    writeFileSync(join(root, "password"), "fixture\n");
    const plan = planScheduledBackup(root);
    expect(plan.action).toBe("launch");
    expect(plan.cue).toContain("failed (exit 7");
    expect(existsSync(join(root, "executed-tool"))).toBeFalse();
  });

  test("environment overrides are included in setup inspection", () => {
    configure();
    process.env.HARNERY_RESTIC_PASSWORD_FILE = join(root, "env-password");
    expect(inspectBackupSetup(backupConfig(root)).missing[0]?.message).toContain("env-password");
  });

  test("filesystem and other restic backends do not require rclone", () => {
    configure("rclone");
    for (const repo of [join(root, "repository"), "s3:example.invalid/backups", "C:\\backups"]) {
      expect(inspectBackupSetup({ ...backupConfig(root), repo }).missing).toEqual([]);
    }
  });

  test("inline rclone backends do not require a named remote", () => {
    configure("remote");
    expect(
      inspectBackupSetup({ ...backupConfig(root), repo: "rclone::local:/fixture" }).missing,
    ).toEqual([]);
  });

  test("rclone remotes configured only by environment are available", () => {
    configure("remote");
    process.env.RCLONE_CONFIG_ARCHIVE_TYPE = "local";
    expect(inspectBackupSetup(backupConfig(root)).missing).toEqual([]);
  });

  test("encrypted rclone config remains eligible for a real run", () => {
    configure("remote");
    writeFileSync(join(root, "rclone.conf"), "# Encrypted\nRCLONE_ENCRYPT_V0:\nfixture\n");
    expect(inspectBackupSetup(backupConfig(root)).missing).toEqual([]);
    expect(planScheduledBackup(root).action).toBe("launch");
  });

  test("a config read error remains an operational failure", () => {
    configure();
    process.env.RCLONE_CONFIG = join(root, "config-directory");
    mkdirSync(process.env.RCLONE_CONFIG);
    expect(inspectBackupSetup(backupConfig(root)).missing).toEqual([]);
  });

  test("a missing explicit rclone config never falls back to another file", () => {
    configure();
    writeFileSync(join(root, "bin", "rclone.conf"), "[archive]\ntype = local\n");
    process.env.RCLONE_CONFIG = join(root, "missing-config");
    expect(inspectBackupSetup(backupConfig(root)).missing[0]?.code).toBe("rclone_remote_missing");
  });

  test("rclone config discovery uses the first existing file", () => {
    configure();
    delete process.env.RCLONE_CONFIG;
    const xdg = join(root, "xdg", "rclone");
    mkdirSync(xdg, { recursive: true });
    writeFileSync(join(xdg, "rclone.conf"), "[archive]\ntype = local\n");
    expect(inspectBackupSetup(backupConfig(root)).missing).toEqual([]);
    writeFileSync(join(root, "bin", "rclone.conf"), "[different]\ntype = local\n");
    expect(inspectBackupSetup(backupConfig(root)).missing[0]?.code).toBe("rclone_remote_missing");
  });

  test("rclone config discovery falls back to the home config and legacy file", () => {
    configure();
    delete process.env.RCLONE_CONFIG;
    writeFileSync(join(root, ".rclone.conf"), "[archive]\ntype = local\n");
    expect(inspectBackupSetup(backupConfig(root)).missing).toEqual([]);
    const configDir = join(root, ".config", "rclone");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "rclone.conf"), "[different]\ntype = local\n");
    expect(inspectBackupSetup(backupConfig(root)).missing[0]?.code).toBe("rclone_remote_missing");
  });

  test.if(process.platform === "win32")("rclone prefers AppData over XDG on Windows", () => {
    configure();
    delete process.env.RCLONE_CONFIG;
    const appData = join(root, "appdata", "rclone");
    const xdg = join(root, "xdg", "rclone");
    mkdirSync(appData, { recursive: true });
    mkdirSync(xdg, { recursive: true });
    writeFileSync(join(appData, "rclone.conf"), "[different]\ntype = local\n");
    writeFileSync(join(xdg, "rclone.conf"), "[archive]\ntype = local\n");
    expect(inspectBackupSetup(backupConfig(root)).missing[0]?.code).toBe("rclone_remote_missing");
  });

  test("changed rclone sections are visible on the next check without a subprocess", () => {
    configure("remote");
    expect(inspectBackupSetup(backupConfig(root)).missing).toHaveLength(1);
    writeFileSync(join(root, "rclone.conf"), "  [archive]  # fixture\r\ntype = local\r\n");
    expect(inspectBackupSetup(backupConfig(root)).missing).toEqual([]);
  });
});

async function snapshot(args: string[] = []): Promise<{
  exitCode: number;
  errors: Array<{ code: string; message: string }>;
}> {
  const result = { exitCode: 0, errors: [] as Array<{ code: string; message: string }> };
  const emit: EmitContext = {
    config() {},
    data() {},
    rows() {},
    text() {},
    file() {},
    error: (issue) => result.errors.push(issue as { code: string; message: string }),
    log() {},
    setExitCode: (code) => {
      result.exitCode = code;
    },
  };
  const program = new Command();
  registerBackupCommand(program, emit);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await program.parseAsync(["node", "harn", "backup", "snapshot", ...args]);
  } finally {
    process.chdir(cwd);
  }
  return result;
}

function configure(missing?: (typeof prerequisites)[number]): void {
  for (const binary of ["restic", "rclone"]) {
    if (missing === binary) continue;
    const name = process.platform === "win32" ? `${binary}.exe` : binary;
    // A local executable fixture. Preflight must never execute it.
    writeFileSync(
      join(root, "bin", name),
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(join(root, "executed-tool"))}, "unexpected tool execution"); process.exit(99);\n`,
      { mode: 0o755 },
    );
  }
  if (missing !== "password") writeFileSync(join(root, "password"), "fixture\n");
  writeFileSync(
    join(root, "rclone.conf"),
    missing === "remote" ? "[different]\ntype = local\n" : "[archive]\ntype = local\n",
  );
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    JSON.stringify({
      backup: {
        repo: "rclone:archive:backups/project",
        password_file: "password",
        schedule: { if_stale: "24h" },
      },
    }),
  );
}
