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
  // Deferred: a last-boundary refresh is unlinked; deletion needs writer-coordinated custody.
  test.todo("keeps a heartbeat refreshed immediately before unlink", () => {
    const root = fixtureRoot();
    seedV3Session(root, "final-read", { sessionId: "final-read-session" });
    const heartbeat = staleGenerationHeartbeat(root, "final-read");
    const initial = JSON.parse(readFileSync(heartbeat, "utf8"));
    const fresh = { ...initial, last_heartbeat: new Date().toISOString() };
    const originalUnlink = fs.unlinkSync;
    let refreshed = false;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (path === heartbeat) {
        refreshed = true;
        writeFileSync(heartbeat, JSON.stringify(fresh));
      }
      return originalUnlink(path);
    });
    let result: ReturnType<typeof staleSweep>;
    try {
      result = staleSweep(root);
    } finally {
      unlink.mockRestore();
    }

    expect(refreshed).toBeTrue();
    expect(result.heartbeatsRemoved).toEqual([]);
    expect(JSON.parse(readFileSync(heartbeat, "utf8"))).toEqual(fresh);
  });

  // Deferred: the audit resolves the replacement generation rather than the observed generation.
  test.todo("does not attribute a stale observation to a generation replaced during its audit", () => {
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

  // Deferred: an audit-time refresh is deleted using the earlier stale observation.
  test.todo("keeps a heartbeat refreshed while the sweep audit is recorded", () => {
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

  // Deferred: a stale read deletes a subsequent heartbeat from the same generation.
  test.todo("keeps a same-generation heartbeat refreshed after the stale read", () => {
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

  // Deferred: a stale read deletes the replacement generation's cache.
  test.todo("keeps a replacement generation written after the stale read", () => {
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

  // Deferred: the first directory snapshot misses a new owner and its pid-map entry is deleted.
  test.todo("rechecks an owner absent from the earlier directory snapshot before pruning its pid map", () => {
    const root = fixtureRoot();
    const active = join(root, ".harnery", "active");
    mkdirSync(active, { recursive: true });
    const pidmap = writePidmap(root, "arriving");
    const originalRead = fs.readdirSync;
    let injected = false;
    const read = spyOn(fs, "readdirSync").mockImplementation(((
      ...args: Parameters<typeof fs.readdirSync>
    ) => {
      const entries = Reflect.apply(originalRead, fs, args);
      if (!injected && args[0] === active) {
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
    }

    expect(injected).toBeTrue();
    expect(existsSync(join(active, "arriving.json"))).toBeTrue();
    expect(existsSync(pidmap)).toBeTrue();
    expect(result.pidmapsRemoved).toBe(0);
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

  // Deferred: an old pid-map read deletes a replacement owner's mapping.
  test.todo("keeps a pid-map entry reassigned after its old owner was read", () => {
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
  const originalRead = fs.readFileSync;
  let injected = false;
  const read = spyOn(fs, "readFileSync").mockImplementation(((
    ...args: Parameters<typeof fs.readFileSync>
  ) => {
    const content = Reflect.apply(originalRead, fs, args);
    if (!injected && args[0] === path) {
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
  }
}
