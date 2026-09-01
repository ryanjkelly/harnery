import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Browser } from "../../src/lib/browser/client.ts";
import { CookieJar } from "../../src/lib/cookies/client.ts";

const harneryRoot = resolve(import.meta.dir, "../..");
const writerFixture = resolve(import.meta.dir, "../fixtures/browser-cookie-writer.ts");
const children: ChildProcess[] = [];

setDefaultTimeout(45_000);

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForExit(child).catch(() => {});
  }
});

describe("shared browser cookie store", () => {
  test("browser startup identifies a stable cookie-store parse failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-browser-cookie-parse-"));
    const store = join(root, "cookies.json");
    const malformed = '{"cookies":[\u0000]}\n';
    writeFileSync(store, malformed);
    const browser = new Browser({
      jar: new CookieJar({ path: store }),
      profileDir: join(root, "profile"),
    });

    await expect(browser.open()).rejects.toThrow(
      `Failed to open browser during cookie-store load: Cookie-store parse failed at "${store}"`,
    );
    expect(readFileSync(store, "utf8")).toBe(malformed);
  });

  test("two browser children preserve valid JSON and merge both sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-browser-cookie-race-"));
    const store = join(root, "cookies.json");
    new CookieJar({ path: store, source: "test-seed" }).save({ cookies: [], origins: [] });

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const writer = url.searchParams.get("writer") ?? "unknown";
      response.setHeader("set-cookie", `writer_${writer}=${writer}; Path=/; SameSite=Lax`);
      response.end("<!doctype html><title>cookie writer</title><p>ready</p>");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no TCP port");
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const go = join(root, "go");
      const writers = ["alpha", "beta"].map((writer) => {
        const ready = join(root, `${writer}.ready`);
        const child = spawn(
          process.execPath,
          [writerFixture, store, join(root, `${writer}-profile`), origin, writer, ready, go],
          { cwd: harneryRoot, stdio: ["ignore", "pipe", "pipe"] },
        );
        children.push(child);
        return { child, ready, writer };
      });

      await waitFor(
        () => writers.every(({ ready }) => existsSync(ready)),
        writers.map(({ child, writer }) => ({ child, writer })),
      );
      writeFileSync(go, "close\n");

      let observations = 0;
      while (writers.some(({ child }) => child.exitCode === null && child.signalCode === null)) {
        JSON.parse(readFileSync(store, "utf8"));
        observations++;
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 1));
      }

      const exits = await Promise.all(
        writers.map(async ({ child, writer }) => ({
          writer,
          code: await waitForExit(child),
          stderr: await readStream(child.stderr),
        })),
      );
      expect(exits).toEqual([
        { writer: "alpha", code: 0, stderr: "" },
        { writer: "beta", code: 0, stderr: "" },
      ]);
      expect(observations).toBeGreaterThan(0);

      const final = JSON.parse(readFileSync(store, "utf8")) as {
        cookies: { name: string; value: string }[];
      };
      expect(final.cookies).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "writer_alpha", value: "alpha" }),
          expect.objectContaining({ name: "writer_beta", value: "beta" }),
        ]),
      );
    } finally {
      await new Promise<void>((resolveClose, rejectClose) =>
        server.close((error) => (error ? rejectClose(error) : resolveClose())),
      );
    }
  });
});

async function waitFor(
  predicate: () => boolean,
  watched: { child: ChildProcess; writer: string }[],
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    const earlyExit = watched.find(
      ({ child }) => child.exitCode !== null || child.signalCode !== null,
    );
    if (earlyExit) {
      throw new Error(`${earlyExit.writer} browser child exited before the close barrier`);
    }
    if (Date.now() >= deadline) throw new Error("timed out waiting for browser children");
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
}

async function waitForExit(child: ChildProcess, timeoutMs = 15_000): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return await Promise.race([
    new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
    new Promise<never>((_, rejectTimeout) =>
      setTimeout(() => rejectTimeout(new Error("timed out waiting for browser child")), timeoutMs),
    ),
  ]);
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (!stream) return "";
  let output = "";
  for await (const chunk of stream) output += chunk.toString();
  return output;
}
