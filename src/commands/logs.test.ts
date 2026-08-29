import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { registerLogsCommand } from "./logs.ts";

describe("logs command", () => {
  test("lists registered log families without creating dormant roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-logs-command-"));
    const payloads: unknown[] = [];
    const emit: EmitContext = {
      config() {},
      data: (payload) => {
        payloads.push(payload);
      },
      rows() {},
      text() {},
      file() {},
      error: (error) => {
        throw error;
      },
      log() {},
      setExitCode() {},
    };
    try {
      const program = new Command();
      registerLogsCommand(program, emit, { repoRoot: root, resolveCoordRoot: () => root });
      await program.parseAsync(["node", "harn", "logs", "list", "--json"]);
      const report = payloads[0] as { schema: string; families: Array<{ family_id: string }> };
      expect(report.schema).toBe("harnery.logs-list/v1");
      expect(
        report.families.some((family) => family.family_id === "agent-hook-debug-log"),
      ).toBeTrue();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
