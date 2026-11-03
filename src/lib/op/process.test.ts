import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { readStdinText, runProcess, runProcessSync, sleepSync, which } from "./process.ts";

const linux = process.platform === "linux";

describe("runProcess", () => {
  test("captures stdout, stderr and the exit code", async () => {
    const r = await runProcess(["sh", "-c", "echo out; echo err >&2; exit 3"]);
    expect(r).toMatchObject({ stdout: "out\n", stderr: "err\n", exitCode: 3 });
  });

  test.if(linux)("leaves stdin ignored without input and connects it with input", async () => {
    const probe = ["readlink", "/proc/self/fd/0"];
    expect((await runProcess(probe)).stdout.trim()).toBe("/dev/null");
    expect((await runProcess(probe, { input: "" })).stdout.trim()).not.toBe("/dev/null");
  });

  test("writes input to stdin and closes it", async () => {
    const r = await runProcess(["cat"], { input: '{"a":1}' });
    expect(r.stdout).toBe('{"a":1}');
  });

  test("reports a missing binary as exit 127 with its errno", async () => {
    const r = await runProcess(["definitely-not-a-real-binary-xyz"]);
    expect(r.exitCode).toBe(127);
    expect(r.spawnErrno).toBe("ENOENT");
  });

  test("kills a child that outlives its timeout", async () => {
    const started = Date.now();
    const r = await runProcess(["sleep", "5"], { timeoutMs: 100 });
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("runProcessSync", () => {
  test("captures output and exit code", () => {
    expect(runProcessSync(["sh", "-c", "echo hi; exit 2"])).toMatchObject({
      stdout: "hi\n",
      exitCode: 2,
    });
  });

  test("reports a missing binary as exit 127 with its errno", () => {
    const r = runProcessSync(["definitely-not-a-real-binary-xyz"]);
    expect(r.exitCode).toBe(127);
    expect(r.spawnErrno).toBe("ENOENT");
    expect(r.stderr).not.toBe("");
  });
});

describe("helpers", () => {
  test("which finds sh and rejects a missing name", () => {
    expect(which("sh")).toBeString();
    expect(which("definitely-not-a-real-binary-xyz")).toBeUndefined();
  });

  test("sleepSync blocks for roughly the requested time", () => {
    const started = Date.now();
    sleepSync(50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  test("readStdinText joins every chunk", async () => {
    expect(await readStdinText(Readable.from([Buffer.from("ab"), "cd"]))).toBe("abcd");
  });
});
