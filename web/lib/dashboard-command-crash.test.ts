import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CommandStorage, dashboardCommandClient } from "./dashboard-command-client";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function lines(child: ChildProcessWithoutNullStreams) {
  const seen: string[] = [];
  let buffer = "";
  let stderr = "";
  const waiting: {
    prefix: string;
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }[] = [];
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      const index = waiting.findIndex((entry) => line.startsWith(entry.prefix));
      if (index < 0) seen.push(line);
      else waiting.splice(index, 1)[0]!.resolve(line);
    }
  });
  child.once("error", (error) => {
    for (const entry of waiting.splice(0)) entry.reject(error);
  });
  child.once("exit", (code, signal) => {
    for (const entry of waiting.splice(0))
      entry.reject(new Error(`HTTP fixture exited ${code}/${signal}: ${stderr}`));
  });
  return (prefix: string): Promise<string> => {
    const index = seen.findIndex((line) => line.startsWith(prefix));
    if (index >= 0) return Promise.resolve(seen.splice(index, 1)[0]!);
    if (child.exitCode !== null || child.signalCode !== null)
      return Promise.reject(new Error(`HTTP fixture already exited: ${stderr}`));
    return new Promise((resolve, reject) => waiting.push({ prefix, resolve, reject }));
  };
}

async function start(root: string, boundary: string, port = 0) {
  const child = spawn(
    process.execPath,
    [
      join(dirname(fileURLToPath(import.meta.url)), "__fixtures__/dashboard-command-http.ts"),
      root,
      boundary,
      String(port),
    ],
    {
      cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  children.push(child);
  const line = lines(child);
  const address = JSON.parse((await line("LISTENING ")).slice("LISTENING ".length)) as {
    port: number;
    pid: number;
  };
  return { child, line, ...address, origin: `http://127.0.0.1:${address.port}` };
}

function retainedStorage() {
  const values = new Map<string, string>();
  const storage: CommandStorage = {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  return { values, storage };
}

describe("dashboard commands across killed HTTP servers", () => {
  for (const boundary of ["effect", "receipt"] as const) {
    test(`a lost ${boundary} response retains identity across server death and restart`, async () => {
      const root = mkdtempSync(join(tmpdir(), "dashboard-http-crash-"));
      roots.push(root);
      const original = await start(root, boundary);
      const retained = retainedStorage();
      const requests: { method: string; body?: Record<string, unknown> }[] = [];
      let origin = original.origin;
      const transport = (async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
        });
        return fetch(new URL(String(url), origin), init);
      }) as typeof fetch;
      const args = { instance_id: "fixture-owner", message: "once" };
      const makeClient = () =>
        dashboardCommandClient(
          root,
          "ping",
          { instance_id: args.instance_id },
          () => retained.storage,
          transport,
        );
      const lost = makeClient()
        .submit(args)
        .then(
          () => ({ lost: false }),
          () => ({ lost: true }),
        );
      const commandId = (await original.line(`${boundary.toUpperCase()} `)).split(" ")[1]!;
      expect(retained.values.size).toBe(1);
      expect(JSON.parse([...retained.values.values()][0]!).intent).toMatchObject({
        command_id: commandId,
        arguments: args,
      });
      expect(
        existsSync(join(root, ".harnery/dashboard-commands", `${commandId}.settled.json`)),
      ).toBe(boundary === "receipt");
      const exited = once(original.child, "exit");
      expect(original.child.kill("SIGKILL")).toBe(true);
      expect((await exited)[1]).toBe("SIGKILL");
      expect(await lost).toEqual({ lost: true });

      const restarted = await start(root, "serve", original.port);
      origin = restarted.origin;
      expect(restarted.pid).not.toBe(original.pid);
      const outcome = await makeClient().recover();
      const state = boundary === "receipt" ? "settled" : "unknown";
      expect(outcome).toMatchObject({ command_id: commandId, state, arguments: args });
      if (boundary === "receipt")
        expect(outcome?.result).toEqual({ ok: true, target_instance: args.instance_id, bytes: 4 });
      else
        expect(await makeClient().submit(args)).toMatchObject({
          command_id: commandId,
          state: "unknown",
        });
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);

      // A duplicate transport delivery of the original intent must also be safe.
      const replay = await fetch(`${origin}/api/actions/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requests[0]!.body),
      });
      const replayed = await replay.json();
      expect(
        readFileSync(join(root, "effects.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([{ command_id: commandId, pid: original.pid }]);
      expect(replayed).toMatchObject({ command_id: commandId, state });
      expect(retained.values.size).toBe(1);
    }, 20_000);
  }
});
