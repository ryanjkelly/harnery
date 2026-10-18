import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import {
  recordLiveHookSignalV3,
  resolveLiveEventLedgerRouteV3,
} from "../../events/v3/live-routing.ts";
import { readLedgerV3 } from "../../events/v3/reader.ts";
import { eventV3Paths } from "../../events/v3/writer.ts";
import * as lifecycle from "../live-lifecycle-v3.ts";
import { staleSweep } from "./stale-sweep.ts";
import * as fileCustody from "./unchanged-file.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-stale-sweep-conformance-"));
  roots.push(root);
  initializeV3Fixture(root);
  return root;
}

function readSweepDiagnostics(root: string): Array<Record<string, unknown>> {
  const diagnostics = eventV3Paths(root).diagnostics;
  if (!existsSync(diagnostics)) return [];
  return readdirSync(diagnostics)
    .filter((name) => name.startsWith("heartbeat_sweep_unrecorded-") && name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(diagnostics, name), "utf8")));
}

describe("staleSweep fresh ownership checks", () => {
  test("keeps a heartbeat refreshed immediately before unlink", () => {
    const root = fixtureRoot();
    seedV3Session(root, "final-read", { sessionId: "final-read-session" });
    const heartbeat = staleGenerationHeartbeat(root, "final-read");
    const initial = JSON.parse(readFileSync(heartbeat, "utf8"));
    const fresh = { ...initial, last_heartbeat: new Date().toISOString() };
    const originalUnlink = fs.unlinkSync;
    const originalRename = fs.renameSync;
    let refreshed = false;
    const refreshAtBoundary = (path: fs.PathLike) => {
      if (!refreshed && path === heartbeat) {
        refreshed = true;
        writeFileSync(heartbeat, JSON.stringify(fresh));
      }
    };
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      refreshAtBoundary(path);
      return originalUnlink(path);
    });
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      refreshAtBoundary(from);
      return originalRename(from, to);
    });
    let result: ReturnType<typeof staleSweep>;
    try {
      result = staleSweep(root);
    } finally {
      unlink.mockRestore();
      rename.mockRestore();
    }

    expect(refreshed).toBeTrue();
    expect(result.heartbeatsRemoved).toEqual([]);
    expect(JSON.parse(readFileSync(heartbeat, "utf8"))).toEqual(fresh);
  });

  test("does not attribute a stale observation to a generation replaced during its audit", () => {
    const root = fixtureRoot();
    seedV3Session(root, "audit-generation", { sessionId: "audit-generation-session" });
    const heartbeat = staleGenerationHeartbeat(root, "audit-generation");
    const oldGeneration = JSON.parse(readFileSync(heartbeat, "utf8")).v3_generation_id;
    const originalRecord = lifecycle.recordLiveSweepObservationV3;
    let replacementGeneration: string | undefined;
    const record = spyOn(lifecycle, "recordLiveSweepObservationV3").mockImplementation((input) => {
      const route = resolveLiveEventLedgerRouteV3(root);
      if (route.state !== "v3") throw new Error(`fixture_v3_route:${route.reason}`);
      expect(
        recordLiveHookSignalV3({
          coordRoot: root,
          route,
          eventName: "session-end",
          adapter: "codex",
          instanceId: "audit-generation",
          payload: { session_id: "audit-generation-session", raw: {} },
        }).state,
      ).toBe("recorded");
      seedV3Session(root, "audit-generation", { sessionId: "audit-generation-session" });
      replacementGeneration = JSON.parse(readFileSync(heartbeat, "utf8")).v3_generation_id;
      expect(replacementGeneration).not.toBe(oldGeneration);
      return originalRecord(input);
    });
    try {
      staleSweep(root);
      expect(record).toHaveBeenCalledTimes(1);
    } finally {
      record.mockRestore();
    }

    expect(
      readLedgerV3(root).events.filter(
        ({ event }) =>
          event.event_type === "lifecycle.sweep_observed" &&
          "generation_id" in event.scope &&
          event.scope.generation_id === replacementGeneration,
      ),
    ).toEqual([]);
    expect(existsSync(heartbeat)).toBeTrue();
  });

  test("keeps a heartbeat refreshed while the sweep audit is recorded", () => {
    const root = fixtureRoot();
    seedV3Session(root, "audited", { sessionId: "audited-session" });
    const heartbeat = staleGenerationHeartbeat(root, "audited");
    const initial = JSON.parse(readFileSync(heartbeat, "utf8"));
    const fresh = { ...initial, last_heartbeat: new Date().toISOString() };
    const originalRecord = lifecycle.recordLiveSweepObservationV3;
    const record = spyOn(lifecycle, "recordLiveSweepObservationV3").mockImplementation((input) => {
      const result = originalRecord(input);
      writeFileSync(heartbeat, JSON.stringify(fresh));
      return result;
    });
    let result: ReturnType<typeof staleSweep>;
    try {
      result = staleSweep(root);
      expect(record).toHaveBeenCalledTimes(1);
    } finally {
      record.mockRestore();
    }

    expect(result.heartbeatsRemoved).toEqual([]);
    expect(JSON.parse(readFileSync(heartbeat, "utf8"))).toEqual(fresh);
  });

  test("keeps a same-generation heartbeat refreshed after the stale read", () => {
    const root = fixtureRoot();
    seedV3Session(root, "refreshed", { sessionId: "refreshed-session" });
    const heartbeat = staleGenerationHeartbeat(root, "refreshed");
    const initial = JSON.parse(readFileSync(heartbeat, "utf8"));
    const fresh = { ...initial, last_heartbeat: new Date().toISOString() };
    const pidmap = writePidmap(root, "refreshed");

    const result = afterFileRead(
      heartbeat,
      () => {
        writeFileSync(heartbeat, JSON.stringify(fresh));
      },
      () => staleSweep(root),
    );

    expect(result.heartbeatsRemoved).toEqual([]);
    expect(existsSync(heartbeat)).toBeTrue();
    expect(JSON.parse(readFileSync(heartbeat, "utf8"))).toEqual(fresh);
    expect(existsSync(pidmap)).toBeTrue();
    expect(result.pidmapsRemoved).toBe(0);
    expect(
      readLedgerV3(root).events.some(({ event }) => event.event_type === "session.ended"),
    ).toBeFalse();
  });

  test("keeps a replacement generation written after the stale read", () => {
    const root = fixtureRoot();
    seedV3Session(root, "replaced", { sessionId: "replaced-session" });
    const heartbeat = staleGenerationHeartbeat(root, "replaced");
    const oldGeneration = JSON.parse(readFileSync(heartbeat, "utf8")).v3_generation_id;
    const pidmap = writePidmap(root, "replaced");
    let replacementGeneration: string | undefined;

    const result = afterFileRead(
      heartbeat,
      () => {
        const route = resolveLiveEventLedgerRouteV3(root);
        if (route.state !== "v3") throw new Error(`fixture_v3_route:${route.reason}`);
        expect(
          recordLiveHookSignalV3({
            coordRoot: root,
            route,
            eventName: "session-end",
            adapter: "codex",
            instanceId: "replaced",
            payload: { session_id: "replaced-session", raw: {} },
          }).state,
        ).toBe("recorded");
        seedV3Session(root, "replaced", { sessionId: "replaced-session" });
        replacementGeneration = JSON.parse(readFileSync(heartbeat, "utf8")).v3_generation_id;
        expect(replacementGeneration).not.toBe(oldGeneration);
      },
      () => staleSweep(root),
    );

    expect(result.heartbeatsRemoved).toEqual([]);
    expect(existsSync(heartbeat)).toBeTrue();
    expect(JSON.parse(readFileSync(heartbeat, "utf8")).v3_generation_id).toBe(
      replacementGeneration,
    );
    expect(existsSync(pidmap)).toBeTrue();
    expect(
      readLedgerV3(root).events.filter(
        ({ event }) =>
          event.event_type === "lifecycle.sweep_observed" &&
          "generation_id" in event.scope &&
          event.scope.generation_id === replacementGeneration,
      ),
    ).toEqual([]);
  });

  test("rechecks an owner absent from the earlier directory snapshot before pruning its pid map", () => {
    const root = fixtureRoot();
    const active = join(root, ".harnery", "active");
    mkdirSync(active, { recursive: true });
    const pidmap = writePidmap(root, "arriving");
    const originalRead = fs.readdirSync;
    const originalRecover = fileCustody.recoverInterruptedFileDeletions;
    let insideRecovery = false;
    let injected = false;
    const recover = spyOn(fileCustody, "recoverInterruptedFileDeletions").mockImplementation(
      (...args) => {
        const previous = insideRecovery;
        insideRecovery = true;
        try {
          return originalRecover(...args);
        } finally {
          insideRecovery = previous;
        }
      },
    );
    const read = spyOn(fs, "readdirSync").mockImplementation(((
      ...args: Parameters<typeof fs.readdirSync>
    ) => {
      const entries = Reflect.apply(originalRead, fs, args);
      if (!injected && !insideRecovery && args[0] === active) {
        injected = true;
        seedV3Session(root, "arriving", { sessionId: "arriving-session" });
      }
      return entries;
    }) as typeof fs.readdirSync);
    let result: ReturnType<typeof staleSweep>;
    try {
      result = staleSweep(root);
    } finally {
      read.mockRestore();
      recover.mockRestore();
    }

    expect(injected).toBeTrue();
    expect(existsSync(join(active, "arriving.json"))).toBeTrue();
    expect(existsSync(pidmap)).toBeTrue();
    expect(result.pidmapsRemoved).toBe(0);
  });

  test("keeps a pid-map entry when its owner publishes after the mapping is pinned", () => {
    const root = fixtureRoot();
    const owner = "pid-pin-owner";
    mkdirSync(join(root, ".harnery", "active"), { recursive: true });
    const pidmap = writePidmap(root, owner);
    const originalBytes = readFileSync(pidmap);
    const originalRename = fs.renameSync;
    let injected = false;
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      originalRename(from, to);
      if (!injected && from === pidmap) {
        injected = true;
        seedV3Session(root, owner, { sessionId: `${owner}-session` });
      }
    });
    let result: ReturnType<typeof staleSweep>;
    try {
      result = staleSweep(root);
    } finally {
      rename.mockRestore();
    }

    expect(injected).toBeTrue();
    expect(result.pidmapsRemoved).toBe(0);
    expect(readFileSync(pidmap)).toEqual(originalBytes);
    const heartbeat = JSON.parse(
      readFileSync(join(root, ".harnery", "active", `${owner}.json`), "utf8"),
    );
    expect(heartbeat.v3_generation_id).toBeDefined();
    expect(
      readLedgerV3(root).events.some(
        ({ event }) =>
          event.event_type === "session.started" &&
          "generation_id" in event.scope &&
          event.scope.generation_id === heartbeat.v3_generation_id,
      ),
    ).toBeTrue();
  });

  test("keeps a remote presence row and its session outside the local sweep", () => {
    const root = fixtureRoot();
    const remote = join(root, ".harnery", "presence", "remote", "other-host.json");
    mkdirSync(dirname(remote), { recursive: true });
    const body = JSON.stringify({
      v: 1,
      machine: "other-host",
      published_at: "2020-01-01T00:00:00.000Z",
      agents: [
        {
          instance_id: "remote-agent",
          session_id: "remote-session",
          platform: "codex",
          activity: "working",
          task_state: "active",
          last_heartbeat: "2020-01-01T00:00:00.000Z",
        },
      ],
    });
    writeFileSync(remote, body);
    const old = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(remote, old, old);
    const ledgerBefore = readFileSync(eventV3Paths(root).active);

    expect(staleSweep(root).heartbeatsRemoved).toEqual([]);
    expect(readFileSync(remote, "utf8")).toBe(body);
    expect(readFileSync(eventV3Paths(root).active)).toEqual(ledgerBefore);
    expect(readSweepDiagnostics(root)).toEqual([]);
  });

  test("keeps a pid-map entry reassigned after its old owner was read", () => {
    const root = fixtureRoot();
    seedV3Session(root, "current", { sessionId: "current-session" });
    const pidmap = writePidmap(root, "missing");
    const replacement = "current\t5678\n";

    const result = afterFileRead(
      pidmap,
      () => {
        writeFileSync(pidmap, replacement);
      },
      () => staleSweep(root),
    );

    expect(result.pidmapsRemoved).toBe(0);
    expect(readFileSync(pidmap, "utf8")).toBe(replacement);
  });
});

function staleGenerationHeartbeat(root: string, instanceId: string): string {
  const heartbeat = join(root, ".harnery", "active", `${instanceId}.json`);
  const current = JSON.parse(readFileSync(heartbeat, "utf8"));
  writeFileSync(
    heartbeat,
    JSON.stringify({ ...current, last_heartbeat: "2020-01-01T00:00:00.000Z" }),
  );
  return heartbeat;
}

function writePidmap(root: string, instanceId: string): string {
  const path = join(root, ".harnery", "pid-map", instanceId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${instanceId}\t1234\n`);
  return path;
}

function afterFileRead<T>(path: string, update: () => void, run: () => T): T {
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalRead = fs.readFileSync;
  const descriptors = new Set<number>();
  let injected = false;
  const open = spyOn(fs, "openSync").mockImplementation((source, flags, mode) => {
    const descriptor = originalOpen(source, flags, mode);
    if (source === path) descriptors.add(descriptor);
    return descriptor;
  });
  const close = spyOn(fs, "closeSync").mockImplementation((descriptor) => {
    descriptors.delete(descriptor);
    return originalClose(descriptor);
  });
  const read = spyOn(fs, "readFileSync").mockImplementation(((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    const content = Reflect.apply(originalRead, fs, args);
    if (
      !injected &&
      (args[0] === path || (typeof args[0] === "number" && descriptors.has(args[0])))
    ) {
      injected = true;
      update();
    }
    return content;
  }) as typeof fs.readFileSync);
  try {
    const result = run();
    expect(injected).toBeTrue();
    return result;
  } finally {
    read.mockRestore();
    close.mockRestore();
    open.mockRestore();
  }
}
