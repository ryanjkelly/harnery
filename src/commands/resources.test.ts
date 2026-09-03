import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { resourceStatusFixture } from "../../tests/helpers/resource-status.ts";
import type { EmitContext } from "../commander.ts";
import { resourcePaths } from "../core/resources/storage.ts";
import { registerResourcesCommand } from "./resources.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harn-resource-command-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function run(args: string[]) {
  const data: unknown[] = [];
  const text: string[] = [];
  const formats: string[] = [];
  const emit: EmitContext = {
    config: (v) => {
      if (v.format) formats.push(v.format);
    },
    data: (v) => {
      data.push(v);
    },
    text: (v) => {
      text.push(v);
    },
    rows() {},
    file() {},
    error(e) {
      throw e;
    },
    log() {},
    setExitCode() {},
  };
  const program = new Command().name("project");
  registerResourcesCommand(program, emit, { resolveCoordRoot: () => root });
  await program.parseAsync(["resources", "status", ...args], { from: "user" });
  return { data, text, formats };
}

test("status defaults to concise human output with a separate explicit JSON mode", async () => {
  resourceStatusFixture(root);
  const human = await run([]);
  expect(human.text.join("\n")).toContain("CPU 30%");
  expect(human.data).toHaveLength(0);
  const json = await run(["--json"]);
  expect(json.formats).toContain("json");
  expect(json.data[0]).toMatchObject({ state: "fresh", namespace: "wsl" });
  expect(JSON.stringify(json.data)).not.toContain("should-not-appear");
  expect(json.text).toHaveLength(0);
});

test("reports missing, malformed, and stale caches without starting services", async () => {
  expect((await run(["--json"])).data[0]).toMatchObject({
    state: "unavailable",
    reason: "snapshot_missing",
  });
  expect(readdirSync(root)).toHaveLength(0);
  resourceStatusFixture(root, Date.now() - 30_000);
  expect((await run(["--json"])).data[0]).toMatchObject({ state: "stale", machine: null });
  writeFileSync(resourcePaths(root).snapshot, "broken");
  expect((await run(["--json"])).data[0]).toMatchObject({
    state: "unavailable",
    reason: "snapshot_invalid",
  });
  expect((await run([])).text.join("\n")).toContain("project supervisor start");
});

test("root selects the cache and process details require an explicit option", async () => {
  resourceStatusFixture(root);
  expect((await run(["--root", root, "--processes", "--json"])).data[0]).toMatchObject({
    processes: [{ pid: 1, name: "worker" }],
  });
  expect((await run(["--root", join(root, "missing"), "--json"])).data[0]).toMatchObject({
    reason: "snapshot_missing",
  });
});
