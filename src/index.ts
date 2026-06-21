/**
 * Public library entry. Re-exports the harn-able surface for consumers that
 * import harnery as a library rather than calling the CLI.
 *
 * Examples of intended consumption:
 *   import { createHarneryProgram } from 'harnery';     // CLI composition
 *   import { evaluateClaim } from 'harnery/core/agents'; // verdict rule directly
 *   import type { Heartbeat } from 'harnery/core/agents'; // schema types
 *
 * Heavy modules (web UI, hook scripts) are not re-exported from here; they're
 * reachable via their own subpath entries in package.json#exports.
 */

export type { HarneryContextOpts, HarneryProgramContext } from "./commander.ts";
export { createHarneryProgram } from "./commander.ts";
