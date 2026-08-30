import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  loadAllLazyCommands,
  loadLazyCommand,
  onLazyCommandLoaded,
  registerLazyCommandBundles,
} from "../../src/lazy-commands.ts";

describe("lazy top-level commands", () => {
  test("root help uses metadata without loading implementations", () => {
    const loaded: string[] = [];
    const program = new Command().name("demo");
    registerLazyCommandBundles(program, [
      {
        commands: [
          {
            command: "alpha <value>",
            description: "Alpha command",
            aliases: ["a"],
            hasOptions: true,
          },
        ],
        load(root) {
          loaded.push("alpha");
          root.command("alpha <value>").description("Alpha command").option("--real");
        },
      },
    ]);

    expect(program.helpInformation()).toContain("alpha|a [options] <value>");
    expect(program.helpInformation()).toContain("Alpha command");
    expect(loaded).toEqual([]);
  });

  test("parseAsync loads only the selected implementation", async () => {
    const loaded: string[] = [];
    const values: string[] = [];
    const program = new Command();
    registerLazyCommandBundles(program, [
      {
        commands: [{ command: "alpha <value>", description: "Alpha" }],
        load(root) {
          loaded.push("alpha");
          root.command("alpha <value>").action((value: string) => {
            values.push(value);
          });
        },
      },
      {
        commands: [{ command: "beta", description: "Beta" }],
        load(root) {
          loaded.push("beta");
          root.command("beta");
        },
      },
    ]);

    await program.parseAsync(["alpha", "one"], { from: "user" });
    expect(loaded).toEqual(["alpha"]);
    expect(values).toEqual(["one"]);
  });

  test("routes through root options and aliases", async () => {
    let ran = false;
    const program = new Command().option("--format <format>");
    registerLazyCommandBundles(program, [
      {
        commands: [{ command: "alpha", description: "Alpha", aliases: ["a"] }],
        load(root) {
          root
            .command("alpha")
            .alias("a")
            .action(() => {
              ran = true;
            });
        },
      },
    ]);

    await program.parseAsync(["--format", "json", "a"], { from: "user" });
    expect(ran).toBeTrue();
  });

  test("materializes bundles and runs load hooks once", async () => {
    const program = new Command();
    program.command("static");
    let hookCalls = 0;
    registerLazyCommandBundles(program, [
      {
        commands: [
          { command: "alpha", description: "Alpha" },
          { command: "beta", description: "Beta" },
        ],
        load(root) {
          root.command("alpha");
          root.command("beta");
        },
      },
    ]);
    await onLazyCommandLoaded(program, "alpha", () => {
      hookCalls++;
    });

    expect((await loadLazyCommand(program, "alpha"))?.name()).toBe("alpha");
    await loadAllLazyCommands(program);
    expect(hookCalls).toBe(1);
    expect(program.commands.map((command) => command.name())).toEqual([
      "static",
      "alpha",
      "beta",
    ]);
  });

  test("restores placeholders when a loader fails", async () => {
    const program = new Command();
    let attempts = 0;
    registerLazyCommandBundles(program, [
      {
        commands: [{ command: "alpha", description: "Alpha command" }],
        load(root) {
          attempts++;
          root.command("alpha");
          if (attempts === 1) throw new Error("temporary failure");
        },
      },
    ]);

    expect(loadLazyCommand(program, "alpha")).rejects.toThrow("temporary failure");
    expect(program.helpInformation()).toContain("alpha");
    expect((await loadLazyCommand(program, "alpha"))?.name()).toBe("alpha");
  });

  test("sync parse refuses an unloaded implementation", () => {
    const program = new Command();
    registerLazyCommandBundles(program, [
      {
        commands: [{ command: "alpha", description: "Alpha" }],
        load(root) {
          root.command("alpha");
        },
      },
    ]);

    expect(() => program.parse(["alpha"], { from: "user" })).toThrow("use parseAsync()");
  });
});
