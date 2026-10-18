import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import {
  readCoordinationViewV3,
  requireAuthoritySafeCoordinationViewV3,
} from "../../events/v3/coordination-view.ts";
import {
  liveInstanceIdV3,
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../events/v3/live-routing.ts";
import { heartbeatPath, readHeartbeat } from "./heartbeat-reader.ts";
import * as projection from "./live-coordination-view.ts";
import { repairLiveCoordinationHeartbeat } from "./live-coordination-writer.ts";
import { staleSweep } from "./stale-sweep.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-heartbeat-custody-"));
  roots.push(root);
  initializeV3Fixture(root);
  return root;
}

function canonicalGeneration(root: string, owner: string): `gen_${string}` {
  const generation = requireAuthoritySafeCoordinationViewV3(readCoordinationViewV3(root)).instances[
    liveInstanceIdV3(owner)
  ];
  if (!generation) throw new Error("fixture_generation_missing");
  const generationId = generation.generation_id;
  if (!generationId.startsWith("gen_")) throw new Error("fixture_generation_id_invalid");
  return generationId as `gen_${string}`;
}

function makeStale(root: string, owner: string): { path: string; fresh: string } {
  const path = heartbeatPath(root, owner);
  const row = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...row, last_heartbeat: "2020-01-01T00:00:00.000Z" }));
  return { path, fresh: JSON.stringify({ ...row, last_heartbeat: new Date().toISOString() }) };
}

function dependentFiles(root: string, owner: string): Array<[string, string]> {
  const pidmap = join(root, ".harnery", "pid-map");
  fs.mkdirSync(pidmap, { recursive: true });
  const files: Array<[string, string]> = [
    [join(pidmap, owner), `${owner}\t1234\n`],
    [join(root, ".harnery", `.last-peer-hash.${owner}`), "peer-hash"],
    [join(root, ".harnery", `.last-resource-hash.${owner}`), "resource-hash"],
  ];
  for (const [path, content] of files) writeFileSync(path, content);
  return files;
}

interface ChildResult {
  state: "published" | "refused";
  error?: string;
}

function child(root: string, owner: string, operation: string): ChildResult {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
        import { setTask, setIdentityCache } from ${JSON.stringify(new URL("./heartbeat-writer.ts", import.meta.url).href)};
        import { ensureLiveCoordinationHeartbeat, repairLiveCoordinationHeartbeat } from ${JSON.stringify(new URL("./live-coordination-writer.ts", import.meta.url).href)};
        import { recordLiveHookSignalV3, resolveLiveEventLedgerRouteV3 } from ${JSON.stringify(new URL("../../events/v3/live-routing.ts", import.meta.url).href)};
        import { staleSweep } from ${JSON.stringify(new URL("./stale-sweep.ts", import.meta.url).href)};
        const root = ${JSON.stringify(root)};
        const owner = ${JSON.stringify(owner)};
        const session = owner + "-session";
        try {
          ${operation}
          process.stdout.write(JSON.stringify({ state: "published" }));
        } catch (error) {
          process.stdout.write(JSON.stringify({ state: "refused", error: error instanceof Error ? error.message : String(error) }));
        }
      `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) throw new Error(`fixture_child:${result.error ?? result.stderr}`);
  return JSON.parse(result.stdout) as ChildResult;
}

const replaceInChild = `
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("fixture_route_blocked");
  for (const eventName of ["session-end", "session-start"]) {
    const result = recordLiveHookSignalV3({ coordRoot: root, route, eventName, adapter: "codex", instanceId: owner, payload: { session_id: session, raw: {} } });
    if (result.state !== "recorded" && result.state !== "already_started") throw new Error("fixture_hook_refused:" + result.state);
  }
  if (!repairLiveCoordinationHeartbeat(root, owner, session, "codex")) throw new Error("fixture_repair_missing");
`;

function replaceGeneration(root: string, owner: string): void {
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("fixture_route_blocked");
  expect(
    recordLiveHookSignalV3({
      coordRoot: root,
      route,
      eventName: "session-end",
      adapter: "codex",
      instanceId: owner,
      payload: { session_id: `${owner}-session`, raw: {} },
    }).state,
  ).toBe("recorded");
  seedV3Session(root, owner, { sessionId: `${owner}-session` });
}

test("publication refuses a sweep's temporary missing heartbeat and succeeds on retry", () => {
  const root = fixture();
  const owner = "pinned-owner";
  seedV3Session(root, owner, { sessionId: `${owner}-session` });
  seedV3Session(root, "independent", { sessionId: "independent-session" });
  const generation = canonicalGeneration(root, owner);
  const { path } = makeStale(root, owner);
  const dependencies = dependentFiles(root, owner);
  const originalRename = fs.renameSync;
  const attempts: Array<{ result: ChildResult; missing: boolean }> = [];
  let independent: ChildResult | undefined;
  let competingSweep: ChildResult | undefined;
  let dependentBytesDuringPin: Array<string | undefined> | undefined;
  let injected = false;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    originalRename(from, to);
    if (!injected && from === path) {
      injected = true;
      for (const operation of [
        'setTask(root, owner, "must retry");',
        'setIdentityCache(root, owner, "Changed", "identity-changed");',
        'ensureLiveCoordinationHeartbeat(root, owner, session, "codex");',
        'repairLiveCoordinationHeartbeat(root, owner, session, "codex");',
      ]) {
        attempts.push({ result: child(root, owner, operation), missing: !existsSync(path) });
      }
      independent = child(root, "independent", 'setTask(root, owner, "independent publication");');
      competingSweep = child(root, owner, "staleSweep(root);");
      dependentBytesDuringPin = dependencies.map(([file]) =>
        existsSync(file) ? readFileSync(file, "utf8") : undefined,
      );
    }
  });
  try {
    staleSweep(root);
  } finally {
    rename.mockRestore();
  }

  expect(injected).toBeTrue();
  expect(attempts).toHaveLength(4);
  for (const attempt of attempts) {
    expect(attempt.result.state).toBe("refused");
    expect(attempt.result.error).toContain("live or unexpired owner");
    expect(attempt.missing).toBeTrue();
  }
  expect(independent?.state).toBe("published");
  expect(competingSweep?.state).toBe("published");
  expect(dependentBytesDuringPin).toEqual(dependencies.map(([, content]) => content));
  expect(readHeartbeat(root, "independent")?.task).toBe("independent publication");
  expect(readHeartbeat(root, "independent")?.v3_generation_id).toBe(
    canonicalGeneration(root, "independent"),
  );
  expect(canonicalGeneration(root, owner)).toBe(generation);
  expect(repairLiveCoordinationHeartbeat(root, owner, `${owner}-session`, "codex")).not.toBeNull();
  expect(child(root, owner, 'setTask(root, owner, "usable retry");').state).toBe("published");
  expect(readHeartbeat(root, owner)?.task).toBe("usable retry");
  expect(readHeartbeat(root, owner)?.v3_generation_id).toBe(generation);
});

test("a generation transition cannot replace a heartbeat during another process's publication", () => {
  const root = fixture();
  const owner = "publishing-owner";
  seedV3Session(root, owner, { sessionId: `${owner}-session` });
  const generation = canonicalGeneration(root, owner);
  const path = heartbeatPath(root, owner);
  const originalRename = fs.renameSync;
  let replacement: ChildResult | undefined;
  let injected = false;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (!injected && to === path && from !== path) {
      injected = true;
      replacement = child(root, owner, replaceInChild);
    }
    return originalRename(from, to);
  });
  try {
    repairLiveCoordinationHeartbeat(root, owner, `${owner}-session`, "codex");
  } finally {
    rename.mockRestore();
  }

  expect(injected).toBeTrue();
  expect(replacement?.state).toBe("refused");
  expect(canonicalGeneration(root, owner)).toBe(generation);
  expect(readHeartbeat(root, owner)?.v3_generation_id).toBe(generation);
  expect(child(root, owner, replaceInChild).state).toBe("published");
  const replacementGeneration = canonicalGeneration(root, owner);
  expect(replacementGeneration).not.toBe(generation);
  expect(readHeartbeat(root, owner)?.v3_generation_id).toBe(replacementGeneration);
});

test("stale materialization cannot overwrite a replacement created during projection", () => {
  const root = fixture();
  const owner = "projection-owner";
  seedV3Session(root, owner, { sessionId: `${owner}-session` });
  const generation = canonicalGeneration(root, owner);
  const path = heartbeatPath(root, owner);
  const originalProject = projection.projectHeartbeatV3;
  let replacementBytes: Buffer<ArrayBuffer> | undefined;
  let injected = false;
  const project = spyOn(projection, "projectHeartbeatV3").mockImplementation((...args) => {
    const projected = originalProject(...args);
    if (!injected && args[1].instance_id === liveInstanceIdV3(owner)) {
      injected = true;
      replaceGeneration(root, owner);
      replacementBytes = readFileSync(path);
    }
    return projected;
  });
  let failure: unknown;
  try {
    repairLiveCoordinationHeartbeat(root, owner, `${owner}-session`, "codex");
  } catch (error) {
    failure = error;
  } finally {
    project.mockRestore();
  }

  expect(injected).toBeTrue();
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain("authority_generation_changed");
  expect(canonicalGeneration(root, owner)).not.toBe(generation);
  expect(readHeartbeat(root, owner)?.v3_generation_id).toBe(canonicalGeneration(root, owner));
  if (replacementBytes === undefined) throw new Error("fixture_replacement_bytes_missing");
  expect(readFileSync(path)).toEqual(replacementBytes);
});

test("a cache without its generation witness cannot publish until V3 rematerializes it", () => {
  const root = fixture();
  const owner = "unbound-owner";
  seedV3Session(root, owner, { sessionId: `${owner}-session` });
  const generation = canonicalGeneration(root, owner);
  const path = heartbeatPath(root, owner);
  const row = JSON.parse(readFileSync(path, "utf8"));
  delete row.v3_generation_id;
  const unbound = JSON.stringify(row);
  writeFileSync(path, unbound);

  for (const operation of [
    'setTask(root, owner, "unbound task");',
    'setIdentityCache(root, owner, "Unbound", "unbound-identity");',
  ]) {
    const result = child(root, owner, operation);
    expect(result.state).toBe("refused");
    expect(result.error).toContain("authority_generation_changed");
    expect(readFileSync(path, "utf8")).toBe(unbound);
    expect(canonicalGeneration(root, owner)).toBe(generation);
  }

  expect(repairLiveCoordinationHeartbeat(root, owner, `${owner}-session`, "codex")).not.toBeNull();
  expect(readHeartbeat(root, owner)?.v3_generation_id).toBe(generation);
  expect(child(root, owner, 'setTask(root, owner, "bound retry");').state).toBe("published");
  expect(
    child(root, owner, 'setIdentityCache(root, owner, "Bound", "bound-identity");').state,
  ).toBe("published");
  expect(readHeartbeat(root, owner)?.task).toBe("bound retry");
  expect(readHeartbeat(root, owner)?.name).toBe("Bound");
  expect(readHeartbeat(root, owner)?.v3_generation_id).toBe(generation);
});

test("a killed sweep restores a refreshed pinned heartbeat before publication retries", () => {
  const root = fixture();
  const owner = "killed-owner";
  seedV3Session(root, owner, { sessionId: `${owner}-session` });
  const generation = canonicalGeneration(root, owner);
  const { path, fresh } = makeStale(root, owner);
  const dependencies = dependentFiles(root, owner);
  const killed = spawnSync(
    process.execPath,
    [
      "-e",
      `
        import { spyOn } from "bun:test";
        import * as fs from "node:fs";
        import { staleSweep } from ${JSON.stringify(new URL("./stale-sweep.ts", import.meta.url).href)};
        const path = ${JSON.stringify(path)};
        const originalRename = fs.renameSync;
        spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (from === path) {
            fs.writeFileSync(path, ${JSON.stringify(fresh)});
            originalRename(from, to);
            fs.writeSync(1, JSON.stringify({ pinned: to, missing: !fs.existsSync(path) }));
            process.kill(process.pid, "SIGKILL");
          }
          return originalRename(from, to);
        });
        staleSweep(${JSON.stringify(root)});
      `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );

  expect(killed.signal).toBe("SIGKILL");
  const handoff = JSON.parse(killed.stdout) as { pinned: string; missing: boolean };
  expect(handoff.missing).toBeTrue();
  expect(readFileSync(handoff.pinned, "utf8")).toBe(fresh);
  expect(staleSweep(root).heartbeatsRemoved).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(fresh);
  expect(existsSync(handoff.pinned)).toBeFalse();
  for (const [file, content] of dependencies) expect(readFileSync(file, "utf8")).toBe(content);
  expect(canonicalGeneration(root, owner)).toBe(generation);
  expect(child(root, owner, 'setTask(root, owner, "recovered publication");').state).toBe(
    "published",
  );
  expect(readHeartbeat(root, owner)?.task).toBe("recovered publication");
  expect(readHeartbeat(root, owner)?.v3_generation_id).toBe(generation);
});

test("failed restoration retains fresh bytes for the next sweep to recover", () => {
  const root = fixture();
  const owner = "failed-owner";
  seedV3Session(root, owner, { sessionId: `${owner}-session` });
  const generation = canonicalGeneration(root, owner);
  const { path, fresh } = makeStale(root, owner);
  const originalRename = fs.renameSync;
  const originalLink = fs.linkSync;
  let pin: fs.PathLike | undefined;
  const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (from === path) {
      pin = to;
      writeFileSync(path, fresh);
    }
    return originalRename(from, to);
  });
  const link = spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (to === path) {
      throw Object.assign(new Error("injected_restore_denied"), { code: "EACCES" });
    }
    return originalLink(from, to);
  });
  try {
    staleSweep(root);
  } finally {
    link.mockRestore();
    rename.mockRestore();
  }

  expect(pin).toBeDefined();
  expect(existsSync(path)).toBeFalse();
  expect(readFileSync(pin as fs.PathLike, "utf8")).toBe(fresh);
  expect(staleSweep(root).heartbeatsRemoved).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(fresh);
  expect(existsSync(pin as fs.PathLike)).toBeFalse();
  expect(readHeartbeat(root, owner)?.v3_generation_id).toBe(canonicalGeneration(root, owner));
  expect(canonicalGeneration(root, owner)).toBe(generation);
});
