import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeV3Fixture, seedV3Session } from "../../tests/helpers/event-v3-runtime.ts";
import { resourceStatusFixture } from "../../tests/helpers/resource-status.ts";
import { resourcePaths } from "../core/resources/storage.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("agent status exposes cache totals in JSON and keeps coordination usable without measurements", () => {
  const root = mkdtempSync(join(tmpdir(), "harn-agents-resource-"));
  roots.push(root);
  initializeV3Fixture(root);
  seedV3Session(root, "resource-reader", {
    name: "ResourceFixture",
    task: "inspect resource cache",
  });
  resourceStatusFixture(root);
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../cli.ts", import.meta.url)),
        "agents",
        "status",
        "--session-id",
        "resource-reader",
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 15_000,
        env: {
          ...process.env,
          HARNERY_COORD_ROOT_OVERRIDE: root,
          HARNERY_AGENT_COORD_OWNER: "resource-reader",
        },
      },
    );
  const json = run("--json");
  expect(json.status).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({
    resources: { state: "fresh", namespace: "wsl", machine: { cpu_percent: 30 } },
  });
  expect(json.stdout).not.toContain("should-not-appear");
  // Without a warning the compact box leaves the resource row out; --full keeps it.
  const human = run();
  expect(human.status).toBe(0);
  expect(human.stdout).not.toContain("CPU 30%");
  const full = run("--full");
  expect(full.status).toBe(0);
  expect(full.stdout).toContain("resources");
  expect(full.stdout).toContain("CPU 30%");
  rmSync(resourcePaths(root).snapshot);
  const missing = run("--json");
  expect(missing.status).toBe(0);
  expect(JSON.parse(missing.stdout)).toMatchObject({
    resources: { state: "unavailable", reason: "snapshot_missing" },
  });
}, 30_000);
