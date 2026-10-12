import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lazyFetchWebRoot } from "./web-fetch.ts";

type Call = { command: string; args: string[]; cwd?: string };
const calls: Call[] = [];

// Simulate git and the package manager: a clone creates the checkout with web/,
// an install creates node_modules in its working directory.
const fakeSpawn = ((command: string, args: string[], options: { cwd?: string } = {}) => {
  calls.push({ command, args, cwd: options.cwd });
  if (command === "git" && args[0] === "clone")
    mkdirSync(join(args.at(-1)!, "web"), { recursive: true });
  if (args[0] === "install" && options.cwd)
    mkdirSync(join(options.cwd, "node_modules"), { recursive: true });
  return { status: 0 };
}) as never;

const emit = {
  log: () => {},
  error: (e: unknown) => {
    throw new Error(JSON.stringify(e));
  },
} as never;

describe("lazyFetchWebRoot", () => {
  let cache = "";
  const saved = { xdg: process.env.XDG_CACHE_HOME, ref: process.env.HARNERY_WEB_REF };
  beforeEach(() => {
    cache = mkdtempSync(join(tmpdir(), "harnery-web-fetch-"));
    process.env.XDG_CACHE_HOME = cache;
    process.env.HARNERY_WEB_REF = "v9.9.9";
    calls.length = 0;
  });
  afterEach(() => {
    if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved.xdg;
    if (saved.ref === undefined) delete process.env.HARNERY_WEB_REF;
    else process.env.HARNERY_WEB_REF = saved.ref;
    rmSync(cache, { recursive: true, force: true });
  });

  test("installs the harnery root and web/ so next.config can resolve playwright", () => {
    const root = join(cache, "harnery", "web", "v9.9.9");
    expect(lazyFetchWebRoot(emit, fakeSpawn)).toBe(join(root, "web"));
    const installs = calls.filter((call) => call.args[0] === "install").map((call) => call.cwd);
    expect(installs).toEqual([root, join(root, "web")]);
  });

  test("a cache with only web/ installed is fetched again", () => {
    const root = join(cache, "harnery", "web", "v9.9.9");
    mkdirSync(join(root, "web", "node_modules"), { recursive: true });
    lazyFetchWebRoot(emit, fakeSpawn);
    expect(calls.some((call) => call.command === "git" && call.args[0] === "clone")).toBe(true);
    expect(existsSync(join(root, "node_modules"))).toBe(true);
  });

  test("a fully installed cache is reused without cloning", () => {
    const root = join(cache, "harnery", "web", "v9.9.9");
    mkdirSync(join(root, "node_modules"), { recursive: true });
    mkdirSync(join(root, "web", "node_modules"), { recursive: true });
    expect(lazyFetchWebRoot(emit, fakeSpawn)).toBe(join(root, "web"));
    expect(calls.some((call) => call.command === "git")).toBe(false);
  });
});
