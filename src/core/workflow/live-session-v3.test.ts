import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as filesystem from "node:fs";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveName } from "../agents/state/names.ts";
import { initializeEventLedgerV3 } from "../events/v3/bootstrap.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { liveInstanceIdV3 } from "../events/v3/live-routing.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import { endWorkflowChildSessionV3, startWorkflowChildSessionV3 } from "./live-session-v3.ts";

let root: string;

beforeEach(() => {
  root = join(
    tmpdir(),
    `harnery-wf-child-v3-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(root, { recursive: true });
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "workflow-test",
    hostBuild: "host-test",
    configDigest: `sha256:${"0".repeat(64)}`,
    approvalRecordId: "test-workflow-v3",
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("workflow child V3 lifecycle", () => {
  test("records a workflow-scoped generation and materializes only a disposable V3 cache", () => {
    const child = startWorkflowChildSessionV3({
      coordRoot: root,
      instanceId: "workflow-run-a1",
      runId: "workflow-run",
      agentId: "a1",
      adapter: "codex",
      label: "verify slice",
      model: "gpt-test",
    });

    expect(child).toMatchObject({
      schema_version: 2,
      instance_id: "workflow-run-a1",
      name: "Anna",
      platform: "codex",
      kind: "workflow-child",
      task: "verify slice",
    });
    const generation = readCoordinationViewV3(root).instances[liveInstanceIdV3("workflow-run-a1")];
    expect(generation?.workflow_id).toStartWith("wf_");
    expect(generation?.run_id).toStartWith("run_");
    expect(generation?.phase).toBe("live");
  });

  test("allocates canonical names instead of promoting task labels into identities", () => {
    const first = startWorkflowChildSessionV3({
      coordRoot: root,
      instanceId: "workflow-run-a1",
      runId: "workflow-run",
      agentId: "a1",
      adapter: "codex",
      label: "Re-review implementation corrections",
    });
    const second = startWorkflowChildSessionV3({
      coordRoot: root,
      instanceId: "workflow-run-a2",
      runId: "workflow-run",
      agentId: "a2",
      adapter: "codex",
      label: "Re-review integration corrections",
    });

    expect(first).toMatchObject({
      name: "Anna",
      kind: "workflow-child",
      task: "Re-review implementation corrections",
    });
    expect(second).toMatchObject({
      name: "Bob",
      kind: "workflow-child",
      task: "Re-review integration corrections",
    });
  });

  test("records the authoritative terminal before removing the cache", () => {
    const input = {
      coordRoot: root,
      instanceId: "workflow-run-a2",
      runId: "workflow-run",
      agentId: "a2",
      adapter: "cursor",
    } as const;
    const child = startWorkflowChildSessionV3(input);
    endWorkflowChildSessionV3({
      ...input,
      cleanExit: true,
      expectedGenerationId: child.v3_generation_id!,
    });

    expect(existsSync(join(root, ".harnery", "active", "workflow-run-a2.json"))).toBe(false);
    expect(resolveName(root, "workflow-run-a2")).toEqual({
      name: "Anna",
      kind: "workflow-child",
    });
    const events = readLedgerV3(root)
      .events.map(({ event }) => event)
      .filter((event) => event.scope.instance_id === liveInstanceIdV3("workflow-run-a2"));
    expect(events.map((event) => event.event_type)).toEqual(["session.started", "session.ended"]);
    expect(events[1]?.payload).toMatchObject({
      outcome: "succeeded",
      authority: "approved",
      reason: "approved_explicit_end",
    });
  });

  for (const restorationFails of [false, true]) {
    test(`preserves cache cleanup failure when restoration ${restorationFails ? "also fails" : "succeeds"}`, () => {
      const input = {
        coordRoot: root,
        instanceId: "cache-error-child",
        runId: "cache-errors",
        agentId: "a1",
        adapter: "codex",
      };
      const child = startWorkflowChildSessionV3(input);
      const end = { ...input, cleanExit: true, expectedGenerationId: child.v3_generation_id! };
      const primary = new Error("injected held-cache cleanup failure");
      const restoration = new Error("injected held-cache restoration failure");
      const unlink = filesystem.unlinkSync;
      const link = filesystem.linkSync;
      let injected = false;
      const unlinkFault = spyOn(filesystem, "unlinkSync").mockImplementation((path) => {
        if (!injected && String(path).includes(".terminal-")) {
          injected = true;
          throw primary;
        }
        unlink(path);
      });
      const linkFault = spyOn(filesystem, "linkSync").mockImplementation((from, to) => {
        if (restorationFails && String(from).includes(".terminal-")) throw restoration;
        link(from, to);
      });
      let caught: unknown;
      try {
        endWorkflowChildSessionV3(end);
      } catch (error) {
        caught = error;
      } finally {
        unlinkFault.mockRestore();
        linkFault.mockRestore();
      }
      expect(injected).toBe(true);
      const active = join(root, ".harnery", "active");
      const held = readdirSync(active).filter((name) => name.includes(".terminal-"));
      if (restorationFails) {
        expect(caught).toBeInstanceOf(AggregateError);
        expect((caught as AggregateError).errors).toEqual([primary, restoration]);
        expect((caught as AggregateError).message).toContain(primary.message);
        expect((caught as AggregateError).message).toContain(restoration.message);
        expect(existsSync(join(active, `${input.instanceId}.json`))).toBe(false);
        expect(held).toHaveLength(1);
        expect(JSON.parse(filesystem.readFileSync(join(active, held[0]!), "utf8"))).toMatchObject({
          v3_generation_id: end.expectedGenerationId,
        });
      } else {
        expect(caught).toBe(primary);
        expect(existsSync(join(active, `${input.instanceId}.json`))).toBe(true);
        expect(held).toHaveLength(0);
      }
      expect(
        readCoordinationViewV3(root).terminal_generations[end.expectedGenerationId]?.terminal
          ?.outcome,
      ).toBe("succeeded");
      expect(() => endWorkflowChildSessionV3(end)).not.toThrow();
      expect(readdirSync(active)).toHaveLength(0);
      expect(
        readLedgerV3(root).events.filter(({ event }) => event.event_type === "session.ended"),
      ).toHaveLength(1);
    });
  }

  test("recovers a cache handoff after the cleanup process is killed", () => {
    const input = {
      coordRoot: root,
      instanceId: "crashed-cache-child",
      runId: "cache-crash",
      agentId: "a1",
      adapter: "codex",
    };
    const started = startWorkflowChildSessionV3(input);
    const end = { ...input, cleanExit: true, expectedGenerationId: started.v3_generation_id! };
    const fixture = join(root, "cache-crash.test.ts");
    writeFileSync(
      fixture,
      `
      import { spyOn, test } from "bun:test";
      import * as filesystem from "node:fs";
      import { endWorkflowChildSessionV3 } from ${JSON.stringify(new URL("./live-session-v3.ts", import.meta.url).href)};
      test("crash exactly after the atomic cache move", () => {
        const rename = filesystem.renameSync;
        spyOn(filesystem, "renameSync").mockImplementation((from, to) => {
          rename(from, to);
          if (String(to).includes(".terminal-")) process.kill(process.pid, "SIGKILL");
        });
        endWorkflowChildSessionV3(${JSON.stringify(end)});
      });
    `,
    );
    const crashed = spawnSync(process.execPath, ["test", fixture], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(crashed.signal).toBe("SIGKILL");
    const active = join(root, ".harnery", "active");
    expect(existsSync(join(active, `${input.instanceId}.json`))).toBe(false);
    expect(readdirSync(active).filter((name) => name.includes(".terminal-"))).toHaveLength(1);
    expect(
      readCoordinationViewV3(root).terminal_generations[end.expectedGenerationId]?.terminal
        ?.outcome,
    ).toBe("succeeded");
    expect(() => endWorkflowChildSessionV3(end)).not.toThrow();
    expect(readdirSync(active)).toHaveLength(0);
    expect(
      readLedgerV3(root).events.filter(({ event }) => event.event_type === "session.ended"),
    ).toHaveLength(1);
  });
});
