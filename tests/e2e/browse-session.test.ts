import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserSessionDescriptor } from "../../src/lib/browser/session-control.ts";

const harneryRoot = resolve(import.meta.dir, "../..");
const fixtureHost = resolve(import.meta.dir, "../fixtures/browser-session/host.ts");
const cliEntrypoint = resolve(harneryRoot, "src/cli.ts");
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
    await waitForExit(child).catch(() => {});
  }
});

function privateDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  chmodSync(dir, 0o700);
  return dir;
}

async function startHost(): Promise<{
  child: ChildProcess;
  controlFile: string;
  origin: string;
  descriptor: BrowserSessionDescriptor;
}> {
  const dir = privateDir("harnery-session-e2e-");
  const controlFile = join(dir, "control.json");
  const profile = join(dir, "profile");
  const child = spawn(process.execPath, [fixtureHost, controlFile, profile], {
    cwd: harneryRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const ready = JSON.parse(await readLine(child)) as { ready: boolean; origin: string };
  expect(ready.ready).toBe(true);
  await waitFor(() => existsSync(controlFile));
  const descriptor = JSON.parse(readFileSync(controlFile, "utf8")) as BrowserSessionDescriptor;
  return { child, controlFile, origin: ready.origin, descriptor };
}

function runClient(
  controlFile: string,
  args: string[],
  input?: string,
): { status: number | null; stdout: string; stderr: string; argv: string[] } {
  const argv = ["browse-session", ...args, "--control-file", controlFile];
  const result = spawnSync(process.execPath, [cliEntrypoint, ...argv], {
    cwd: harneryRoot,
    encoding: "utf8",
    input,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, argv };
}

function output(result: ReturnType<typeof runClient>): unknown {
  if (result.status !== 0) {
    throw new Error(`client failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.trim());
}

describe("browse-session process integration", () => {
  test("repeated short-lived clients control one context and close it cleanly", async () => {
    const { child, controlFile, origin, descriptor } = await startHost();
    expect(statSync(controlFile).mode & 0o777).toBe(0o600);
    expect(output(runClient(controlFile, ["status"]))).toMatchObject({
      phase: "ready",
      tab_count: 1,
    });
    expect(output(runClient(controlFile, ["inspect"]))).toMatchObject({
      title: "Live session fixture",
      text: expect.stringContaining("Waiting"),
    });

    const fill = await runClientAsync(
      controlFile,
      ["fill", "--label", "Message"],
      "hello from stdin\n",
    );
    expect(fill.argv).not.toContain("hello from stdin");
    expect(output(fill)).toMatchObject({ revision: 1 });
    expect(
      output(runClient(controlFile, ["click", "--role", "button", "--name", "Apply"])),
    ).toMatchObject({ revision: 2 });
    expect(output(runClient(controlFile, ["inspect", "--selector", "#result"]))).toMatchObject({
      text: "hello from stdin",
    });

    const opened = output(runClient(controlFile, ["open-tab", `${origin}/second`])) as {
      index: number;
    };
    expect(opened.index).toBe(1);
    expect(output(runClient(controlFile, ["tabs"]))).toHaveLength(2);
    expect(output(runClient(controlFile, ["select-tab", "--index", "0"]))).toMatchObject({
      index: 0,
      active: true,
    });
    expect(output(runClient(controlFile, ["close-tab", "--index", "1"]))).toMatchObject({
      index: 0,
      active: true,
    });

    const screenshotPath = join(privateDir("harnery-session-shot-"), "page.png");
    expect(output(runClient(controlFile, ["screenshot", "--out", screenshotPath]))).toMatchObject({
      path: screenshotPath,
    });
    expect(statSync(screenshotPath).mode & 0o777).toBe(0o600);

    expect(output(runClient(controlFile, ["close"]))).toEqual({ closing: true });
    await waitForExit(child);
    expect(existsSync(controlFile)).toBe(false);
    if (descriptor.transport.kind === "unix")
      expect(existsSync(descriptor.transport.address)).toBe(false);
  }, 30_000);

  test("SIGTERM removes the descriptor and socket", async () => {
    const { child, controlFile, descriptor } = await startHost();
    child.kill("SIGTERM");
    await waitForExit(child);
    expect(existsSync(controlFile)).toBe(false);
    if (descriptor.transport.kind === "unix")
      expect(existsSync(descriptor.transport.address)).toBe(false);
  }, 20_000);

  test("browse rejects control descriptors outside login mode before launching Chromium", () => {
    const dir = privateDir("harnery-session-compat-");
    const result = spawnSync(
      process.execPath,
      [
        cliEntrypoint,
        "browse",
        "data:text/html,fixture",
        "--control-file",
        join(dir, "control.json"),
      ],
      { cwd: harneryRoot, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--control-file requires --login");
  });
});

async function readLine(child: ChildProcess): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("fixture stdout unavailable");
  return await new Promise<string>((resolveLine, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolveLine(buffer.slice(0, newline));
    };
    const onExit = () => {
      cleanup();
      reject(new Error("fixture exited before readiness"));
    };
    const cleanup = () => {
      stdout.removeListener("data", onData);
      child.removeListener("exit", onExit);
    };
    stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

async function runClientAsync(
  controlFile: string,
  args: string[],
  input: string,
): Promise<ReturnType<typeof runClient>> {
  const argv = ["browse-session", ...args, "--control-file", controlFile];
  const child = spawn(process.execPath, [cliEntrypoint, ...argv], {
    cwd: harneryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin?.end(input);
  const status = await new Promise<number | null>((resolveStatus) =>
    child.once("exit", (code) => resolveStatus(code)),
  );
  return { status, stdout, stderr, argv };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for fixture state");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("timed out waiting for fixture exit")), timeoutMs),
    ),
  ]);
}
