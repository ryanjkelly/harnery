import { describe, expect, test } from "bun:test";
import { exec } from "./exec.ts";
import { whichBin } from "./which.ts";

test.skipIf(process.platform !== "win32")(
  "background subprocesses have no visible Windows console",
  async () => {
    const script = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class HarneryConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow(); [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd); }'; [HarneryConsoleProbe]::IsWindowVisible([HarneryConsoleProbe]::GetConsoleWindow())`;
    const result = await exec([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("False");
  },
);

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

  test("a process that exits 127 has no errno — indistinguishable from a real 127", async () => {
    const result = await exec([process.execPath, "-e", "process.exit(127)"]);
    expect(result.exitCode).toBe(127);
    // The process itself ran and exited; nothing failed to spawn.
    expect(result.spawnErrno).toBeUndefined();
  });

  // The 127-for-a-missing-command convention belongs to a POSIX shell; native
  // Windows has no `sh` on PATH (cmd.exe reports 9009 instead).
  test.skipIf(!whichBin("sh"))(
    "a shell running a missing command has no errno — the shell spawned fine",
    async () => {
      const result = await exec(["sh", "-c", "harnery-missing-inner-command-xyz"]);
      // sh reports 127 for a not-found command, but sh itself was found, so the
      // spawn produced no errno. This is the case the structural signal must NOT
      // misread as a missing vendor binary.
      expect(result.exitCode).toBe(127);
      expect(result.spawnErrno).toBeUndefined();
    },
  );

  test("an ordinary non-127 exit carries no errno", async () => {
    const result = await exec([process.execPath, "-e", "process.exit(3)"]);
    expect(result.exitCode).toBe(3);
    expect(result.spawnErrno).toBeUndefined();
  });
});

// A harness CLI can start its own children. On timeout, `processGroup` must stop
// all of them, including a grandchild that ignores SIGTERM and holds the pipes.
describe.skipIf(process.platform === "win32")("exec processGroup", () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  async function waitGone(pid: number, ms = 3_000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!alive(pid)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return !alive(pid);
  }

  test("a TERM-ignoring child and grandchild leave nothing behind after the timeout", async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "exec-pgroup-"));
    const pidFile = join(dir, "grandchild.pid");
    let grandchild = 0;
    try {
      const started = Date.now();
      const result = await exec(
        ["sh", "-c", `trap '' TERM; sh -c "trap '' TERM; echo \\$\\$ > ${pidFile}; exec sleep 60" & wait`],
        { timeout: 500, processGroup: { graceMs: 500, drainMs: 200 } },
      );
      grandchild = Number(readFileSync(pidFile, "utf8").trim());
      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(grandchild).toBeGreaterThan(0);
      expect(await waitGone(grandchild)).toBe(true);
    } finally {
      if (grandchild && alive(grandchild)) process.kill(grandchild, "SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  test("a clean child resolves normally and reports no signal", async () => {
    const result = await exec(["sh", "-c", "printf 'a\\n'"], { processGroup: true, raw: true });
    expect(result).toEqual({ stdout: "a\n", stderr: "", exitCode: 0 });
  });

  test("a call that settles before its timeout leaves no watchdog sleep behind", async () => {
    // A distinctive timeout makes the watchdog's `sleep <seconds>` findable.
    const seconds = 7_000 + (process.pid % 1_000);
    const result = await exec(["sh", "-c", "echo done"], { timeout: seconds * 1000, processGroup: true });
    expect(result.stdout).toBe("done");
    const until = Date.now() + 3_000;
    let survivors: string[] = [];
    while (Date.now() < until) {
      const ps = await exec(["ps", "-eo", "args"]);
      survivors = ps.stdout.split("\n").filter((line) => line.trim() === `sleep ${seconds}`);
      if (survivors.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(survivors).toEqual([]);
  });

  test("output past maxOutputBytes kills the group and says so", async () => {
    const result = await exec(["sh", "-c", "yes x"], {
      processGroup: true,
      maxOutputBytes: 64 * 1024,
      timeout: 10_000,
    });
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.timedOut).toBeUndefined();
  });

  test("a missing binary still reports ENOENT", async () => {
    const result = await exec(["harnery-definitely-not-a-real-binary-xyz"], { processGroup: true });
    expect(result.exitCode).toBe(127);
    expect(result.spawnErrno).toBe("ENOENT");
  });
});
