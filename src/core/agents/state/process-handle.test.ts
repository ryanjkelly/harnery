import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { processStartToken, signalIfSameGeneration } from "./proc-start.ts";
import {
  LINUX_PROCESS_HANDLE_SCRIPT,
  signalProcessWithHandle,
  WINDOWS_PROCESS_HANDLE_SCRIPT,
  windowsProcessStartToken,
} from "./process-handle.ts";

test.skipIf(process.platform !== "linux")(
  "a replacement after the last observation cannot receive a numeric PID signal",
  async () => {
    const original = spawn(
      process.execPath,
      ["-e", "console.log('ready');process.stdin.resume()"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const replacement = spawn(
      process.execPath,
      ["-e", "console.log('ready');process.stdin.resume()"],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const originalExit = once(original, "exit");
    const replacementExit = once(replacement, "exit");
    try {
      await Promise.all([once(original.stdout!, "data"), once(replacement.stdout!, "data")]);
      const pid = original.pid!;
      const token = processStartToken(pid)!;
      let rawSignals = 0;
      const result = signalIfSameGeneration(pid, token, "SIGTERM", {
        readToken: () => {
          // A real exit occurs after observation. Numeric PID reuse is modeled at
          // the signal boundary because the test cannot control kernel allocation.
          const exited = spawnSync("python3", [
            "-c",
            `
import os, signal, select, sys
fd = os.pidfd_open(int(sys.argv[1]))
signal.pidfd_send_signal(fd, signal.SIGKILL)
poll = select.poll()
poll.register(fd, select.POLLIN)
assert poll.poll(5000)
os.close(fd)
`,
            String(pid),
          ]);
          expect(exited.status).toBe(0);
          return token;
        },
        ...({
          kill: (_pid: number, signal: NodeJS.Signals | number) => {
            rawSignals++;
            process.kill(replacement.pid!, signal);
          },
        } as object),
      });
      await originalExit;
      expect(rawSignals).toBe(0);
      expect(["same", "unknown"]).toContain(result.verdict);
      expect(replacement.exitCode).toBeNull();
      expect(replacement.signalCode).toBeNull();
    } finally {
      original.kill("SIGKILL");
      replacement.kill("SIGKILL");
      await Promise.all([originalExit, replacementExit]);
    }
  },
);

test("missing native helpers and invalid helper output stay unknown", () => {
  for (const output of [
    { status: null, stdout: null, error: new Error("ENOENT") },
    { status: 1, stdout: '{"sent":true,"verdict":"same"}' },
    { status: 0, stdout: "malformed" },
    { status: 0, stdout: '{"sent":true,"verdict":"unknown"}' },
  ]) {
    expect(
      signalProcessWithHandle(123, "labcd1234.5678", "SIGTERM", {
        platform: "linux",
        run: () => output,
      }),
    ).toEqual({ sent: false, verdict: "unknown" });
  }
  expect(windowsProcessStartToken(123, () => ({ status: null, stdout: null }))).toBeNull();
});

test("unsupported platforms, token dialects and Windows signals never start a helper", () => {
  let calls = 0;
  const run = () => {
    calls++;
    return { status: 0, stdout: "" };
  };
  for (const platform of ["darwin", "linux", "win32"] as const) {
    expect(signalProcessWithHandle(123, "unqualified", "SIGTERM", { platform, run })).toEqual({
      sent: false,
      verdict: "unknown",
    });
  }
  expect(signalProcessWithHandle(123, "w1234", "SIGUSR1", { platform: "win32", run })).toEqual({
    sent: false,
    verdict: "unknown",
  });
  expect(calls).toBe(0);
});

test("Windows creation tokens and handle signals use one native helper invocation", () => {
  expect(
    windowsProcessStartToken(123, (command, args, options) => {
      expect(command).toBe("powershell.exe");
      expect(args).toContain("-NonInteractive");
      expect(options.windowsHide).toBe(true);
      return { status: 0, stdout: '{"sent":false,"verdict":"different","token":"w12345"}' };
    }),
  ).toBe("w12345");
  expect(
    signalProcessWithHandle(123, "w12345", "SIGTERM", {
      platform: "win32",
      run: (_command, _args, options) => {
        expect(JSON.parse(options.input.split("\n")[0]!)).toMatchObject({
          token: "w12345",
          signal: 15,
        });
        return { status: 0, stdout: '{"phase":"verified"}\n{"sent":true,"verdict":"same"}' };
      },
    }),
  ).toEqual({ sent: true, verdict: "same" });
});

test.skipIf(!["linux", "win32"].includes(process.platform))(
  "native retained handle cannot signal a replacement after the verified process exits",
  async () => {
    const original = spawn(
      process.execPath,
      ["-e", "console.log('ready');process.stdin.resume()"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const originalExit = once(original, "exit");
    let replacement: ReturnType<typeof spawn> | undefined;
    let replacementExit: ReturnType<typeof once> | undefined;
    const script =
      process.platform === "linux" ? LINUX_PROCESS_HANDLE_SCRIPT : WINDOWS_PROCESS_HANDLE_SCRIPT;
    const helper = spawn(
      process.platform === "linux" ? "python3" : "powershell.exe",
      process.platform === "linux"
        ? ["-I", "-c", script]
        : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    const helperExit = once(helper, "exit");
    const lines = createInterface({ input: helper.stdout! });
    const output = lines[Symbol.asyncIterator]();
    try {
      await once(original.stdout!, "data");
      helper.stdin!.write(
        `${JSON.stringify({ mode: "signal", pid: original.pid!, token: processStartToken(original.pid!), signal: 15 })}\n`,
      );
      expect(JSON.parse((await output.next()).value!)).toEqual({ phase: "verified" });
      original.kill("SIGKILL");
      await originalExit;
      replacement = spawn(process.execPath, ["-e", "console.log('ready');process.stdin.resume()"], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      replacementExit = once(replacement, "exit");
      await once(replacement.stdout!, "data");
      helper.stdin!.end("signal\n");
      expect(JSON.parse((await output.next()).value!)).toMatchObject({
        sent: false,
        verdict: "same",
      });
      expect((await helperExit)[0]).toBe(0);
      expect(replacement.exitCode).toBeNull();
      expect(replacement.signalCode).toBeNull();
    } finally {
      original.kill("SIGKILL");
      replacement?.kill("SIGKILL");
      helper.kill("SIGKILL");
      lines.close();
      await Promise.all([originalExit, ...(replacementExit ? [replacementExit] : []), helperExit]);
    }
  },
);

test.skipIf(!["linux", "win32"].includes(process.platform))(
  "native backend signals only a live matching handle",
  async () => {
    const child = spawn(process.execPath, ["-e", "console.log('ready');process.stdin.resume()"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const exited = once(child, "exit");
    try {
      await once(child.stdout!, "data");
      const token = processStartToken(child.pid!)!;
      const otherToken = process.platform === "linux" ? token.replace(/\d+$/, "0") : "w1";
      expect(signalProcessWithHandle(child.pid!, otherToken, "SIGTERM")).toEqual({
        sent: false,
        verdict: "different",
      });
      expect(signalIfSameGeneration(child.pid!, "different-token", "SIGTERM")).toEqual({
        sent: false,
        verdict: "different",
      });
      expect(signalIfSameGeneration(child.pid!, token, "SIGTERM")).toEqual({
        sent: true,
        verdict: "same",
      });
      await exited;
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  },
);
