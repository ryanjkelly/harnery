import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resourceFindingFixture,
  resourceStatusFixture,
} from "../../../../tests/helpers/resource-status.ts";
import { resourcePaths, writePrivateJsonAtomic } from "../../resources/storage.ts";
import { supervisorPaths } from "../../supervisor/storage.ts";
import { resourceWarningIfChanged } from "./prompt-context.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harn-prompt-resource-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("missing and normal resource caches add no prompt noise", () => {
  expect(resourceWarningIfChanged(root, "self")).toBe("");
  resourceStatusFixture(root);
  expect(resourceWarningIfChanged(root, "self")).toBe("");
  expect(resourceWarningIfChanged(root, "self")).toBe("");
});

test("invalid instance identifiers cannot create resource hash paths", () => {
  resourceStatusFixture(root);
  const before = readdirSync(join(root, ".harnery")).sort();
  for (const id of ["", "../outside", "session/child", "session\\child", ".", "a".repeat(129)]) {
    expect(resourceWarningIfChanged(root, id)).toBe("");
  }
  expect(readdirSync(join(root, ".harnery")).sort()).toEqual(before);
});

test("pressure warnings deduplicate by state per session, not measured percentages", () => {
  const snapshot = resourceStatusFixture(root);
  writePrivateJsonAtomic(supervisorPaths(root).findings, {
    schema_version: 2,
    active: [resourceFindingFixture()],
    transitions: [],
  });
  expect(resourceWarningIfChanged(root, "self")).toContain("Limit new parallel heavy work");
  expect(resourceWarningIfChanged(root, "self")).toBe("");
  writePrivateJsonAtomic(resourcePaths(root).snapshot, {
    ...snapshot,
    machine: { ...snapshot.machine, cpu_percent: 70 },
  });
  expect(resourceWarningIfChanged(root, "self")).toBe("");
  expect(resourceWarningIfChanged(root, "other")).toContain("Resource update");
  writePrivateJsonAtomic(supervisorPaths(root).findings, {
    schema_version: 2,
    active: [resourceFindingFixture("machine.memory-pressure", "critical")],
    transitions: [],
  });
  expect(resourceWarningIfChanged(root, "self")).toContain("Avoid starting additional heavy work");
  resourceStatusFixture(root);
  expect(resourceWarningIfChanged(root, "self")).toContain("warning has cleared");
  expect(resourceWarningIfChanged(root, "self")).toBe("");
});

test("lost or malformed measurements produce one advisory and never stop coordination", () => {
  resourceStatusFixture(root);
  expect(resourceWarningIfChanged(root, "self")).toBe("");
  writeFileSync(resourcePaths(root).snapshot, "malformed");
  expect(resourceWarningIfChanged(root, "self")).toContain("continue normal coordination");
  expect(resourceWarningIfChanged(root, "self")).toBe("");
});

test("prompt guidance uses the configured command name", () => {
  resourceStatusFixture(root);
  writeFileSync(join(root, ".harnery", "config.jsonc"), JSON.stringify({ binName: "project" }));
  writePrivateJsonAtomic(supervisorPaths(root).findings, {
    schema_version: 2,
    active: [resourceFindingFixture()],
    transitions: [],
  });
  expect(resourceWarningIfChanged(root, "self")).toContain("project resources status --json");
});
