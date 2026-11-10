import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { __resetCoordRootCache } from "@/lib/coord-reader";

import { GET } from "./route";

let root = "";
let previousRoot: string | undefined;
const spies: Array<{ mockRestore: () => void }> = [];

beforeEach(() => {
  previousRoot = process.env.HARNERY_COORD_ROOT;
  root = mkdtempSync(path.join(tmpdir(), "stream-route-"));
  mkdirSync(path.join(root, ".harnery", "journal"), { recursive: true });
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
  if (previousRoot === undefined) delete process.env.HARNERY_COORD_ROOT;
  else process.env.HARNERY_COORD_ROOT = previousRoot;
  __resetCoordRootCache();
  rmSync(root, { recursive: true, force: true });
});

describe("/api/stream lifetime", () => {
  test("reader cancellation clears both intervals once", async () => {
    const controller = new AbortController();
    const clear = spyOn(globalThis, "clearInterval");
    spies.push(clear);
    const response = GET(new Request("http://localhost/api/stream", { signal: controller.signal }));
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("event: hello");

    await reader.cancel();
    controller.abort();

    // heartbeat + filesize poll, and no second run from the abort.
    expect(clear).toHaveBeenCalledTimes(2);
  });

  test("request abort alone runs cleanup", async () => {
    const controller = new AbortController();
    const clear = spyOn(globalThis, "clearInterval");
    spies.push(clear);
    const response = GET(new Request("http://localhost/api/stream", { signal: controller.signal }));
    const reader = response.body!.getReader();
    await reader.read();

    controller.abort();
    expect(clear).toHaveBeenCalledTimes(2);
    const next = await reader.read();
    expect(next.done).toBe(true);
  });
});
