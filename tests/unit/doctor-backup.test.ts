import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupSetupCheck, doctorReport } from "../../src/commands/doctor.ts";
import { inspectBackupSetup } from "../../src/core/backup/setup.ts";
import { backupConfig } from "../../src/core/config.ts";
import { removeDir } from "../helpers/remove-dir.ts";

let root: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "harnery-doctor-backup-"));
  mkdirSync(join(root, ".harnery"));
  mkdirSync(join(root, "bin"));
  process.env.PATH = join(root, "bin");
  process.env.RCLONE_CONFIG = join(root, "rclone.conf");
  delete process.env.RCLONE_CONFIG_ARCHIVE_TYPE;
  delete process.env.HARNERY_RESTIC_REPO;
  delete process.env.HARNERY_RESTIC_PASSWORD_FILE;
});

afterEach(() => {
  process.env = savedEnv;
  removeDir(root);
});

type MissingPiece = "restic" | "password" | "rclone" | "remote";

function configure(missing?: MissingPiece, schedule = true): void {
  for (const tool of ["restic", "rclone"]) {
    if (tool === missing) continue;
    const name = process.platform === "win32" ? `${tool}.exe` : tool;
    // Inspection checks presence only and must never execute these fixtures.
    writeFileSync(join(root, "bin", name), "fixture executable", { mode: 0o755 });
  }
  if (missing !== "password") writeFileSync(join(root, "password"), "fixture password");
  writeFileSync(
    join(root, "rclone.conf"),
    missing === "remote" ? "[another]\ntype = local\n" : "[archive]\ntype = local\n",
  );
  writeFileSync(
    join(root, ".harnery", "config.jsonc"),
    JSON.stringify({
      backup: {
        repo: "rclone:archive:backups/project",
        password_file: "password",
        schedule: schedule ? { if_stale: "24h" } : null,
      },
    }),
  );
}

describe("doctor backup setup", () => {
  test("omits the setup line when no schedule or project is configured", () => {
    configure("restic", false);
    expect(backupSetupCheck(root)).toBeNull();
    expect(backupSetupCheck(null)).toBeNull();
  });

  test.each([
    "restic",
    "password",
    "rclone",
    "remote",
  ] as const)("reports missing %s from the shared inspection as runtime info without failing", (piece) => {
    configure(piece);
    const missing = inspectBackupSetup(backupConfig(root)).missing;
    expect(missing).toHaveLength(1);
    const check = backupSetupCheck(root)!;
    expect(check).toEqual({
      name: "backup",
      scope: "runtime",
      severity: "info",
      detail: `not set up on this machine (${missing[0]!.message})`,
    });
    for (const mode of ["fail", "report"] as const) {
      const report = doctorReport([check], { mode, error: null });
      expect(report.exitCode).toBe(0);
      expect(report.json).toMatchObject({
        outcome: "pass",
        summary: { total: 1, ok: 0, info: 1, warn: 0, fail: 0, runtimeFail: 0 },
      });
      expect(report.text).toContain(`ℹ backup  ${check.detail}`);
      expect(report.text).toContain("0 ok, 1 info, 0 warn, 0 fail");
    }
  });

  test("lists all missing pieces returned by inspection", () => {
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
    const missing = inspectBackupSetup(backupConfig(root)).missing;
    expect(missing).toHaveLength(3);
    expect(backupSetupCheck(root)?.detail).toBe(
      `not set up on this machine (${missing.map((piece) => piece.message).join("; ")})`,
    );
  });

  test("reports ok when local setup is complete without executing any tool", () => {
    configure();
    const check = backupSetupCheck(root)!;
    expect(check).toEqual({
      name: "backup",
      scope: "runtime",
      severity: "ok",
      detail: "set up on this machine",
    });
    const report = doctorReport([check], { mode: "fail", error: null });
    expect(report.exitCode).toBe(0);
    expect(report.text).toContain("✓ backup  set up on this machine");
    expect(report.json).toMatchObject({ summary: { ok: 1, info: 0 } });
    expect(existsSync(join(root, ".harnery", "logs"))).toBe(false);
  });

  test("info does not conceal a separate runtime failure", () => {
    configure("restic");
    const report = doctorReport(
      [
        backupSetupCheck(root)!,
        { name: "git", scope: "runtime", severity: "fail", detail: "missing" },
      ],
      { mode: "report", error: null },
    );
    expect(report.exitCode).toBe(1);
    expect(report.json).toMatchObject({ summary: { info: 1, fail: 1, runtimeFail: 1 } });
  });
});
