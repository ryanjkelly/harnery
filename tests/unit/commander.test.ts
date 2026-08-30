import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  createHarneryProgram,
  loadLazyCommand,
  registerHarneryLogStorageCommands,
} from "../../src/commander.ts";
import {
  appendDurableHistoryRecord,
  createInMemoryLoggerRuntime,
  queryLogs,
} from "../../src/core/storage/index.ts";

describe("createHarneryProgram", () => {
  test("returns a Commander program with default binName 'harn'", () => {
    const program = createHarneryProgram();
    expect(program.name()).toBe("harn");
  });

  test("respects custom binName from opts", () => {
    const program = createHarneryProgram({ binName: "acme" });
    expect(program.name()).toBe("acme");
  });

  test("uses the known binName in command help", async () => {
    const program = createHarneryProgram({ binName: "acme" });
    await loadLazyCommand(program, "browse");
    await loadLazyCommand(program, "agents");
    const command = (name: string) => program.commands.find((entry) => entry.name() === name);

    expect(command("outline")?.description()).toContain("`acme toc`");
    expect(command("read")?.description()).toContain("`acme fetch`");
    expect(
      command("browse")?.options.find((option) => option.long === "--html")?.description,
    ).toContain("`acme read -`");

    const agents = command("agents");
    expect(agents?.commands.find((entry) => entry.name() === "wait")?.description()).toContain(
      "`acme agents ping`",
    );
    expect(
      agents?.commands
        .find((entry) => entry.name() === "set-task")
        ?.options.find((option) => option.long === "--session-id")?.description,
    ).toContain("`acme agents list --json`");
  });

  test("version string is set", () => {
    const program = createHarneryProgram();
    expect(program.version()).toBeDefined();
    expect(typeof program.version()).toBe("string");
  });

  test("description is non-empty", () => {
    const program = createHarneryProgram();
    expect(program.description()).toBeTruthy();
  });

  test("registers the logging, inbox, messaging, and conversation surfaces", () => {
    const names = new Set(createHarneryProgram().commands.map((command) => command.name()));
    for (const name of ["logs", "inbox", "messages", "conversations"]) {
      expect(names.has(name), name).toBeTrue();
    }
  });

  test("honors command exclusions for every new top-level surface", () => {
    const excluded = ["logs", "inbox", "messages", "conversations"];
    const names = new Set(
      createHarneryProgram({ skipCommands: excluded }).commands.map((command) => command.name()),
    );
    for (const name of excluded) expect(names.has(name), name).toBeFalse();
    expect(names.has("storage")).toBeTrue();
  });

  test("mounts log storage commands below a host-owned namespace", async () => {
    const host = new Command();
    const namespace = host.command("harnery");
    expect(await registerHarneryLogStorageCommands(namespace)).toBe(namespace);
    expect(namespace.commands.map((command) => command.name()).sort()).toEqual(["logs", "storage"]);
  });

  test("mounts only the selected log storage command below a host namespace", async () => {
    const namespace = new Command().command("harnery");
    await registerHarneryLogStorageCommands(namespace, { commands: ["logs"] });
    expect(namespace.commands.map((command) => command.name())).toEqual(["logs"]);
  });

  test("exports the durable history, logger, and bounded query APIs", () => {
    expect(typeof appendDurableHistoryRecord).toBe("function");
    expect(typeof createInMemoryLoggerRuntime).toBe("function");
    expect(typeof queryLogs).toBe("function");
  });
});
