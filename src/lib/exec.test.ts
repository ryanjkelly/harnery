import { describe, expect, test } from "bun:test";
import { exec } from "./exec.ts";

// ADR 0046: the environment class is a STRUCTURAL signal, not a text match. It
// rests on one machine-verified fact — a binary spawned directly that is absent
// arrives at `proc.on("error")` with errno ENOENT, while a shell that merely
// exits 127 (or runs a missing sub-command) has no such errno. exec() must
// surface that errno so a normalizer can tell the two apart. These run real
// processes rather than mocking spawn, because the whole design leans on the
// real close-code/errno behaviour of the platform.
describe("exec surfaces the spawn errno (ADR 0046)", () => {
  test("a missing binary spawned directly reports ENOENT", async () => {
    const result = await exec(["harnery-definitely-not-a-real-binary-xyz", "--version"]);
    // Collapsed to 127 so existing exit-code branches still fire...
    expect(result.exitCode).toBe(127);
    // ...but the errno is preserved as the field that distinguishes it.
    expect(result.spawnErrno).toBe("ENOENT");
  });

  test("a shell that exits 127 has no errno — indistinguishable from a real 127", async () => {
    const result = await exec(["sh", "-c", "exit 127"]);
    expect(result.exitCode).toBe(127);
    // The shell itself ran and exited; nothing failed to spawn.
    expect(result.spawnErrno).toBeUndefined();
  });

  test("a shell running a missing command has no errno — the shell spawned fine", async () => {
    const result = await exec(["sh", "-c", "harnery-missing-inner-command-xyz"]);
    // sh reports 127 for a not-found command, but sh itself was found, so the
    // spawn produced no errno. This is the case the structural signal must NOT
    // misread as a missing vendor binary.
    expect(result.exitCode).toBe(127);
    expect(result.spawnErrno).toBeUndefined();
  });

  test("an ordinary non-127 exit carries no errno", async () => {
    const result = await exec(["sh", "-c", "exit 3"]);
    expect(result.exitCode).toBe(3);
    expect(result.spawnErrno).toBeUndefined();
  });
});
