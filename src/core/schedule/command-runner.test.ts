import { describe, expect, test } from "bun:test";
import { createScheduleCommandRunner, defaultScheduleCommandRunner } from "./command-runner.ts";

// `process.execPath` is the running Bun or Node binary, so these tests need no
// other program on the machine.
const RUNTIME = process.execPath;

describe("defaultScheduleCommandRunner", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const result = await defaultScheduleCommandRunner([
      RUNTIME,
      "-e",
      "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(3)",
    ]);
    expect(result).toEqual({ exitCode: 3, stdout: "out\n", stderr: "err\n" });
  });

  test("passes arguments literally, with no shell", async () => {
    const tricky = "$(echo nope) ; `x` && 'q' \"d\" *";
    const result = await defaultScheduleCommandRunner([
      RUNTIME,
      "-e",
      "process.stdout.write(process.argv[process.argv.length - 1])",
      tricky,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(tricky);
  });

  test("reports ENOENT for a missing program and does not throw", async () => {
    const result = await defaultScheduleCommandRunner([
      "harnery-schedule-test-no-such-program-0f3a",
    ]);
    expect(result.exitCode).toBeNull();
    expect(result.error).toBe("ENOENT");
  });

  test("an empty argv is EINVAL", async () => {
    const result = await defaultScheduleCommandRunner([]);
    expect(result).toEqual({ exitCode: null, stdout: "", stderr: "", error: "EINVAL" });
  });

  test("kills the child at the deadline", async () => {
    const started = Date.now();
    const result = await defaultScheduleCommandRunner(
      [RUNTIME, "-e", "setTimeout(() => {}, 60000)"],
      { timeoutMs: 300 },
    );
    expect(result.exitCode).toBeNull();
    expect(result.error).toBe("ETIMEDOUT");
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("kills the child past the output cap", async () => {
    const runner = createScheduleCommandRunner({ maxOutputBytes: 1024 });
    const result = await runner([
      RUNTIME,
      "-e",
      "const s = 'x'.repeat(65536); for (let i = 0; i < 1000; i++) process.stdout.write(s); setTimeout(() => {}, 60000)",
    ]);
    expect(result.exitCode).toBeNull();
    expect(result.error).toBe("EMAXBUFFER");
  });
});
