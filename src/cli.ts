/**
 * `harn` CLI entry point.
 *
 * Parses argv, runs the Commander program returned by createHarneryProgram().
 * Consumer CLIs import createHarneryProgram() from `harnery/commander` and
 * compose their own commands on top. See examples/extending-with-commander.ts.
 */

import { createHarneryProgram } from "./commander.ts";

async function main(): Promise<void> {
  const program = createHarneryProgram({
    binName: "harn",
  });

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
