import { describe, expect, test } from "bun:test";
import { harnChildEnv } from "./run-harn";

describe("harnChildEnv", () => {
  test("pins the project and drops the dashboard's NODE_OPTIONS preload", () => {
    const env = harnChildEnv("/work/project", {
      NODE_OPTIONS: "--import=./server-preload.mjs",
      PATH: "/usr/bin",
    } as unknown as NodeJS.ProcessEnv);
    expect(env.HARNERY_COORD_ROOT_OVERRIDE).toBe("/work/project");
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });
});
