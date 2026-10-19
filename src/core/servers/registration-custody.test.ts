import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Command } from "commander";
import type { EmitContext } from "../../commander.ts";
import { registerServersCommand } from "../../commands/servers.ts";
import { processStartToken } from "../agents/state/proc-start.ts";
import { acquireNoClobberLease } from "../workflow/workspaces/leases.ts";
import {
  readServer,
  readServerRecords,
  registerServer,
  serversDir,
  stopServer,
  unregisterServer,
  withServerRegistrationCustody,
} from "./index.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "server-registration-custody-"));
  roots.push(root);
  const record = registerServer(
    { id: "preview", kind: "session", type: "preview", owner: { instance_id: "owner-one" } },
    { coordRoot: root },
  )!;
  const path = join(serversDir(root), "preview.json");
  return { root, record, path };
}

describe("same-id server registration custody", () => {
  test("a different live process cannot replace the registered process", async () => {
    const { root, path } = fixture();
    const child = spawn(
      process.execPath,
      ["-e", "process.stdout.write('ready');process.stdin.resume()"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    children.push(child);
    await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
    const before = readFileSync(path, "utf8");
    expect(() =>
      registerServer(
        { id: "preview", kind: "session", type: "preview", pid: child.pid, owner: null },
        { coordRoot: root },
      ),
    ).toThrow(/registration.*custody/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an exact repeat preserves the original registration and owner", () => {
    const { root, record, path } = fixture();
    const before = readFileSync(path, "utf8");
    const repeated = registerServer(
      {
        id: "preview",
        kind: "session",
        type: "preview",
        start_token: processStartToken(process.pid)!,
        label: "replacement label",
        owner: record.owner,
      },
      { coordRoot: root },
    );
    expect(repeated).toEqual(record);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("an owner transfer cannot reuse the same process generation", () => {
    const { root, path } = fixture();
    const before = readFileSync(path, "utf8");
    expect(() =>
      registerServer(
        { id: "preview", kind: "session", type: "preview", owner: { instance_id: "owner-two" } },
        { coordRoot: root },
      ),
    ).toThrow(/registration.*custody/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test.each([
    "unknown",
    "other-host",
    "malformed",
  ])("an existing %s record is retained", (state) => {
    const { root, record, path } = fixture();
    if (state === "unknown") delete record.start_token;
    if (state === "other-host") record.host = `${hostname()}-remote`;
    writeFileSync(path, state === "malformed" ? "unreadable" : JSON.stringify(record));
    const before = readFileSync(path, "utf8");
    expect(() =>
      registerServer(
        { id: "preview", kind: "session", type: "preview", owner: null },
        { coordRoot: root },
      ),
    ).toThrow(/registration.*custody/);
    expect(readFileSync(path, "utf8")).toBe(before);
    if (state !== "malformed") expect(readServer("preview", { coordRoot: root })).toEqual(record);
  });
});

describe("immutable registration receipts", () => {
  test("an old receipt cannot remove or stop a later registration of the same process", async () => {
    const { root, record } = fixture();
    expect(record.registration_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(unregisterServer(record, { coordRoot: root })).toBe(true);
    const next = registerServer(
      { id: record.id, kind: record.kind, type: record.type, owner: record.owner },
      { coordRoot: root },
    )!;
    expect(next.registration_id).not.toBe(record.registration_id);
    expect(unregisterServer(record, { coordRoot: root })).toBe(false);
    const effects: number[] = [];
    const result = await stopServer(record, {
      coordRoot: root,
      signalDependencies: {
        signalProcess: (pid) => {
          effects.push(pid);
          return { sent: true, verdict: "same" };
        },
      },
    });
    expect(result).toMatchObject({ method: "refused", generation: "unknown" });
    expect(effects).toEqual([]);
    expect(readServer(record.id, { coordRoot: root })).toEqual(next);
    expect(unregisterServer(next, { coordRoot: root })).toBe(true);
  });

  test("a forged receipt cannot remove the real registration", () => {
    const { root, record } = fixture();
    expect(
      unregisterServer(
        { ...record, owner: { instance_id: "different-owner" } },
        { coordRoot: root },
      ),
    ).toBe(false);
    expect(
      unregisterServer({ ...record, start_token: "different-generation" }, { coordRoot: root }),
    ).toBe(false);
    expect(readServer(record.id, { coordRoot: root })).toEqual(record);
  });
});

describe("serialized registration mutation", () => {
  test("simultaneous different processes cannot both own one ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "registration-contenders-"));
    roots.push(root);
    const source = new URL("./index.ts", import.meta.url).pathname;
    const code = `import {registerServer} from ${JSON.stringify(source)}; console.log('ready'); let attempted=false; process.stdin.on('data',()=>{if(attempted)process.exit(0);attempted=true;try{const record=registerServer({id:'shared',kind:'session',type:'preview',owner:null},{coordRoot:${JSON.stringify(root)}});console.log(JSON.stringify({won:true,pid:record.pid}));}catch{console.log(JSON.stringify({won:false,pid:process.pid}));}});`;
    const contenders = await Promise.all(
      [0, 1].map(async () => {
        const child = spawn(process.execPath, ["-e", code], { stdio: ["pipe", "pipe", "ignore"] });
        children.push(child);
        await new Promise<void>((resolve, reject) => {
          child.stdout!.once("data", () => resolve());
          child.once("exit", () => reject(new Error("contender exited before barrier")));
        });
        const result = new Promise<{ won: boolean; pid: number }>((resolve) =>
          child.stdout!.once("data", (data) => resolve(JSON.parse(String(data)))),
        );
        return { child, result };
      }),
    );
    for (const contender of contenders) contender.child.stdin!.write("go\n");
    const results = await Promise.all(contenders.map((contender) => contender.result));
    expect(results.filter((result) => result.won)).toHaveLength(1);
    expect(readServer("shared", { coordRoot: root })?.pid).toBe(
      results.find((result) => result.won)!.pid,
    );
  });

  test("another mutation lease blocks registration and unregister", () => {
    const { root, record, path } = fixture();
    const scope = "server-registration-preview";
    const lease = acquireNoClobberLease({
      path: join(serversDir(root), ".custody", record.id),
      scope,
      authoritySha256: createHash("sha256").update(scope).digest("hex"),
      staleAfterMs: 1,
    });
    const before = readFileSync(path, "utf8");
    try {
      expect(() =>
        registerServer(
          { id: record.id, kind: record.kind, type: record.type, owner: record.owner },
          { coordRoot: root },
        ),
      ).toThrow(/lease/);
      expect(() => unregisterServer(record, { coordRoot: root })).toThrow(/lease/);
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      lease.release();
    }
    expect(unregisterServer(record, { coordRoot: root })).toBe(true);
  });
});

describe("registration custody effects", () => {
  test("a held asynchronous effect blocks replacement until rejection settles", async () => {
    const { root, record } = fixture();
    let rejectEffect!: (error: Error) => void;
    const effect = withServerRegistrationCustody(
      record,
      { coordRoot: root },
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectEffect = reject;
        }),
    );
    expect(() => unregisterServer(record, { coordRoot: root })).toThrow(/lease/);
    expect(() =>
      registerServer(
        { id: record.id, kind: record.kind, type: record.type, owner: record.owner },
        { coordRoot: root },
      ),
    ).toThrow(/lease/);
    rejectEffect(new Error("effect refused"));
    await expect(effect).rejects.toThrow("effect refused");
    expect(readServer(record.id, { coordRoot: root })).toEqual(record);
    expect(unregisterServer(record, { coordRoot: root })).toBe(true);
    const replacement = registerServer(
      { id: record.id, kind: record.kind, type: record.type, owner: record.owner },
      { coordRoot: root },
    )!;
    expect(replacement.registration_id).not.toBe(record.registration_id);
    expect(() =>
      withServerRegistrationCustody(record, { coordRoot: root }, () => {
        throw new Error("callback must not run");
      }),
    ).toThrow(/custody changed/);
    expect(readServer(record.id, { coordRoot: root })).toEqual(replacement);
  });

  test("a forged receipt never invokes an effect", () => {
    const { root, record } = fixture();
    let effects = 0;
    expect(() =>
      withServerRegistrationCustody(
        { ...record, owner: { instance_id: "foreign" } },
        { coordRoot: root },
        () => effects++,
      ),
    ).toThrow(/custody changed/);
    expect(effects).toBe(0);
  });

  test("older schema records are retained and reported as missing custody", () => {
    const { root, record, path } = fixture();
    const legacy = { ...record, schema_version: 1, registration_id: undefined };
    writeFileSync(path, JSON.stringify(legacy));
    const before = readFileSync(path, "utf8");
    expect(() => readServer(record.id, { coordRoot: root })).toThrow(/older schema.*retained/);
    expect(() => readServerRecords({ coordRoot: root })).toThrow(/older schema.*retained/);
    expect(() =>
      registerServer(
        { id: record.id, kind: record.kind, type: record.type, owner: null },
        { coordRoot: root },
      ),
    ).toThrow(/custody is unknown/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});

test("a foreign-realm Promise keeps custody until it settles", async () => {
  const { root, record } = fixture();
  const context: { resolveEffect?: () => void } = {};
  const foreign = runInNewContext(
    "new Promise(resolve => { resolveEffect = resolve })",
    context,
  ) as Promise<void>;
  const effect = withServerRegistrationCustody(record, { coordRoot: root }, () => foreign);
  expect(() => unregisterServer(record, { coordRoot: root })).toThrow(/lease/);
  context.resolveEffect!();
  await effect;
  expect(unregisterServer(record, { coordRoot: root })).toBe(true);
});

test("the PID stop command captures a registration receipt before stopping an unregistered server", async () => {
  const root = mkdtempSync(join(tmpdir(), "server-cli-stop-"));
  roots.push(root);
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const server=Bun.serve({port:0,hostname:'127.0.0.1',fetch:()=>new Response('ok')});console.log(server.port);process.stdin.resume()",
    ],
    { cwd: root, stdio: ["pipe", "pipe", "ignore"] },
  );
  children.push(child);
  await new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const data: unknown[] = [];
  const errors: unknown[] = [];
  let exitCode = 0;
  const program = new Command().name("test-cli").exitOverride();
  registerServersCommand(
    program,
    {
      config: () => {},
      data: (value: unknown) => {
        data.push(value);
      },
      rows: () => {},
      text: () => {},
      file: () => {},
      error: (error: unknown) => {
        errors.push(error);
      },
      log: () => {},
      setExitCode: (code: number) => {
        exitCode = code;
      },
    } satisfies EmitContext,
    { repoRoot: root, resolveCoordRoot: () => root },
  );
  await program.parseAsync(["servers", "stop", "--pid", String(child.pid), "--json"], {
    from: "user",
  });
  expect(exitCode).toBe(0);
  expect(errors).toEqual([]);
  const { results } = data.at(-1) as { results: Array<{ id: string; stopped: boolean }> };
  expect(results[0]?.stopped).toBe(true);
  expect(results[0]?.id).toMatch(/^unregistered-/);
  await exited;
});
