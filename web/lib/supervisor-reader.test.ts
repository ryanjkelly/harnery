import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSupervisor } from "harnery/core/supervisor";
import { createWorkItem } from "harnery/core/work";
import {
  readSupervisorBackgroundService,
  readSupervisorGoal,
  readSupervisors,
} from "./supervisor-reader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervisor dashboard reader", () => {
  test("reads list and detail through the state-only export", () => {
    const root = mkdtempSync(join("/tmp", "harnery-supervisor-web-"));
    roots.push(root);
    const workflowPath = join(root, "workflow.mjs");
    writeFileSync(workflowPath, "export default async () => 'ok';\n");
    createWorkItem({
      coordRoot: root,
      id: "dashboard-work",
      title: "Dashboard work",
      objective: "Render durable state",
      workflowPath,
    });
    createSupervisor({
      coordRoot: root,
      id: "dashboard-goal",
      rootWorkId: "dashboard-work",
      specialists: { reviewer: { instructions: "Review carefully" } },
    });

    expect(readSupervisors(root).map((record) => record.intent.id)).toEqual(["dashboard-goal"]);
    expect(readSupervisorGoal(root, "dashboard-goal")?.projection.state).toBe("ready");
    expect(readSupervisorGoal(root, "../escape")).toBeNull();
    expect(readSupervisorBackgroundService(root)).toEqual({ running: false, stale: false });
  });
});
