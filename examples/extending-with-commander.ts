/**
 * Example: how a consumer CLI composes harnery.
 *
 * The consumer imports `createHarneryProgram()` and adds its own
 * domain-specific commands via Commander's `.addCommand()`. The result is a
 * project-specific CLI whose generic command surface is harnery and whose
 * remaining commands are project-local.
 *
 * Run this example standalone:
 *   bun run examples/extending-with-commander.ts agents status
 *
 * This file is NOT shipped to npm; it's reference material under examples/.
 */

import { Command } from "commander";
import { createHarneryProgram } from "../src/commander.ts";

// Step 1: get harnery's full command tree, scoped to your binName.
const program = createHarneryProgram({
  binName: "mycli",
  context: {
    projectName: "my-monorepo",
  },
});

// Step 2: add your project-specific commands. They live alongside harnery's
// commands under one CLI. `mycli agents status` resolves to harnery's
// implementation; `mycli deploy` resolves to your local command below.

const deployCommand = new Command("deploy")
  .description("Deploy this project (project-specific)")
  .argument("[target]", "Deploy target (e.g. staging, prod)")
  .action((target: string | undefined) => {
    console.log(`(example) mycli deploy would deploy to: ${target ?? "default"}`);
  });

program.addCommand(deployCommand);

// Step 3: run.
await program.parseAsync(process.argv);
