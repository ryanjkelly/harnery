import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";

const roots: string[] = [];
const ACCOUNT = "aaaaaaaa-0000-0000-0000-000000000001";
const ENV = "eeeeeeee-0000-0000-0000-00000000000e";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.HARNERY_COORD_ROOT_OVERRIDE;
});

function fixture(): { root: string; dataDir: string; entry: string } {
  const root = mkdtempSync(join(tmpdir(), "harnery-claude-desktop-command-"));
  const dataDir = join(root, "desktop");
  const entryDir = join(dataDir, "claude-code-sessions", ACCOUNT, ENV);
  const entry = join(entryDir, "local_done.json");
  mkdirSync(entryDir, { recursive: true });
  mkdirSync(join(root, ".harnery"), { recursive: true });
  writeFileSync(
    entry,
    JSON.stringify({
      sessionId: "local_done",
      cliSessionId: "cli-done",
      title: "Agent Ada - complete",
      isArchived: false,
    }),
  );
  writeFileSync(
    join(root, ".harnery", "events.ndjson"),
    `${JSON.stringify({
      schema_version: 1,
      event_id: "done-event",
      event_type: "state.task_state",
      ts: "2026-08-13T12:00:00.000Z",
      instance_id: "instance-done",
      session_id: "cli-done",
      adapter: "claude-code",
      source: "agent-coord",
      data: { state: "done", reason: null },
    })}\n`,
  );
  roots.push(root);
  process.env.HARNERY_COORD_ROOT_OVERRIDE = root;
  return { root, dataDir, entry };
}

async function run(argv: string[]): Promise<unknown[]> {
  const values: unknown[] = [];
  const emit = {
    data: (value: unknown) => values.push(value),
  } as unknown as EmitContext;
  await createHarneryProgram({ emit }).parseAsync(["node", "harn", ...argv]);
  return values;
}

describe("claude-desktop tidy command", () => {
  test("is registered alongside the existing desktop commands", () => {
    const desktop = createHarneryProgram().commands.find(
      (command) => command.name() === "claude-desktop",
    );
    expect(desktop?.commands.map((command) => command.name())).toEqual([
      "accounts",
      "sessions",
      "mirror",
      "tidy",
    ]);
  });

  test("dry-runs by default, then archives and explains the required relaunch", async () => {
    const { dataDir, entry } = fixture();
    const [dryRun] = await run(["claude-desktop", "tidy", "--data-dir", dataDir]);
    expect(dryRun).toMatchObject({
      dry_run: true,
      planned: [{ cli_session_id: "cli-done", source: "lifecycle" }],
      hint: "re-run with --yes to archive",
    });
    expect(JSON.parse(readFileSync(entry, "utf8")).isArchived).toBe(false);

    const [applied] = await run(["claude-desktop", "tidy", "--data-dir", dataDir, "--yes"]);
    expect(applied).toMatchObject({ dry_run: false, archived: 1 });
    expect((applied as { hint: string }).hint).toContain("fully quit the Claude desktop app");
    expect((applied as { hint: string }).hint).toContain("relaunch");
    expect(JSON.parse(readFileSync(entry, "utf8")).isArchived).toBe(true);
  });
});
