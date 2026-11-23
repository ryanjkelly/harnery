/**
 * The default `ScheduleCommandRunner`: runs one program with literal
 * arguments and no shell, hides the window on Windows, kills the child at a
 * deadline, caps the output it keeps, and never throws. Readers receive it
 * through `ScheduleReadContext.runCommand`; tests inject a fake instead.
 */

import { exec } from "../../lib/exec.ts";
import type { ScheduleCommandResult, ScheduleCommandRunner } from "./types.ts";

/** How long a command may run before it is killed. */
export const SCHEDULE_COMMAND_TIMEOUT_MS = 10_000;

/** Combined stdout and stderr bytes kept before the child is killed. */
export const SCHEDULE_COMMAND_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ScheduleCommandRunnerOptions {
  /** Default deadline when a call passes no `timeoutMs`. */
  timeoutMs?: number;
  /** Output cap; past it the child is killed and `error` is "EMAXBUFFER". */
  maxOutputBytes?: number;
}

/** Build a runner with its own default deadline and output cap. */
export function createScheduleCommandRunner(
  defaults: ScheduleCommandRunnerOptions = {},
): ScheduleCommandRunner {
  const maxOutputBytes = defaults.maxOutputBytes ?? SCHEDULE_COMMAND_MAX_OUTPUT_BYTES;
  return async (argv, options) => {
    const program = argv[0];
    if (typeof program !== "string" || program.length === 0) {
      return { exitCode: null, stdout: "", stderr: "", error: "EINVAL" };
    }
    const timeout = options?.timeoutMs ?? defaults.timeoutMs ?? SCHEDULE_COMMAND_TIMEOUT_MS;
    try {
      const result = await exec([...argv], { raw: true, timeout, maxOutputBytes });
      const out: ScheduleCommandResult = {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
      if (result.spawnErrno) {
        out.exitCode = null;
        out.error = result.spawnErrno;
      } else if (result.timedOut) {
        out.exitCode = null;
        out.error = "ETIMEDOUT";
      } else if (result.outputLimitExceeded) {
        out.exitCode = null;
        out.error = "EMAXBUFFER";
      } else if (result.signal) {
        out.exitCode = null;
      }
      return out;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        error: typeof code === "string" && code.length > 0 ? code : "ESPAWN",
      };
    }
  };
}

/** The runner every reader uses outside tests. */
export const defaultScheduleCommandRunner: ScheduleCommandRunner = createScheduleCommandRunner();
