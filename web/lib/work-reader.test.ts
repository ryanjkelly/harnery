import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWorkItem } from "harnery/core/work";
import { readDurableWork, readDurableWorkItem } from "./work-reader";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("work dashboard reader", () => {
  test("reads list and detail from the core projection", () => {
    const root = mkdtempSync(join("/tmp", "harnery-work-web-"));
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

    expect(readDurableWork(root).map((record) => record.intent.id)).toEqual(["dashboard-work"]);
    expect(readDurableWorkItem(root, "dashboard-work")?.projection.state).toBe("ready");
    expect(readDurableWorkItem(root, "../escape")).toBeNull();
  });
});
