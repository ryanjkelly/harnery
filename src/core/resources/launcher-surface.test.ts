import { expect, test } from "bun:test";
import * as resources from "./index.ts";

test("the resource API exposes observation without an unreachable daemon launcher", () => {
  expect(Object.keys(resources)).not.toContain("spawnResourceService");
  expect(Object.keys(resources)).not.toContain("ensureResourceServiceRunning");
  expect(typeof resources.readResourceStatus).toBe("function");
});
