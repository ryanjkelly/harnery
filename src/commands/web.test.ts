import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEB_PORT, resolveWebPort } from "../core/config.ts";
import {
  isWebPortAvailable,
  nodeOptionsWithHeapCap,
  nodeOptionsWithWebDiagnostics,
  resolveMaxOldSpaceMb,
} from "./web.ts";

describe("resolveWebPort", () => {
  let savedEnv: string | undefined;
  let root: string;

  beforeEach(() => {
    savedEnv = process.env.HARNERY_WEB_PORT;
    delete process.env.HARNERY_WEB_PORT;
    root = mkdtempSync(join(tmpdir(), "harnery-web-port-"));
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HARNERY_WEB_PORT;
    else process.env.HARNERY_WEB_PORT = savedEnv;
    rmSync(root, { recursive: true, force: true });
  });

  test("uses the mnemonic HARN port by default", () => {
    expect(resolveWebPort(undefined, root)).toBe(DEFAULT_WEB_PORT);
    expect(DEFAULT_WEB_PORT).toBe(4276);
  });

  test("reads web.port from project config", () => {
    mkdirSync(join(root, ".harnery"));
    writeFileSync(join(root, ".harnery", "config.jsonc"), '{ "web": { "port": 5100 } }');
    expect(resolveWebPort(undefined, root)).toBe(5100);
  });

  test("environment wins over project config and an explicit flag wins over both", () => {
    mkdirSync(join(root, ".harnery"));
    writeFileSync(join(root, ".harnery", "config.jsonc"), '{ "web": { "port": 5100 } }');
    process.env.HARNERY_WEB_PORT = "5200";
    expect(resolveWebPort(undefined, root)).toBe(5200);
    expect(resolveWebPort("5300", root)).toBe(5300);
  });

  test("rejects invalid explicit and environment ports", () => {
    expect(() => resolveWebPort("900", root)).toThrow("--port must be an integer");
    process.env.HARNERY_WEB_PORT = "random";
    expect(() => resolveWebPort(undefined, root)).toThrow("HARNERY_WEB_PORT must be an integer");
  });
});

describe("isWebPortAvailable", () => {
  test("reports a bound port and releases it cleanly", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP address");
    expect(await isWebPortAvailable(address.port)).toBe(false);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(await isWebPortAvailable(address.port)).toBe(true);
  });
});

/**
 * The dashboard's V8 old-space ceiling. Next only supplies its own
 * `--max-old-space-size` when the flag is absent, and it sizes that to roughly
 * half of system RAM — a ceiling a long-lived dashboard never approaches, so
 * V8 never feels enough pressure to run a major GC. These lock the resolution
 * precedence and the NODE_OPTIONS composition that restore that pressure.
 */
describe("resolveMaxOldSpaceMb", () => {
  const DEFAULT_MB = 2048;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.HARNERY_WEB_MAX_OLD_SPACE;
    delete process.env.HARNERY_WEB_MAX_OLD_SPACE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HARNERY_WEB_MAX_OLD_SPACE;
    else process.env.HARNERY_WEB_MAX_OLD_SPACE = savedEnv;
  });

  test("defaults to a bounded ceiling when neither flag nor env is set", () => {
    expect(resolveMaxOldSpaceMb(undefined)).toBe(DEFAULT_MB);
  });

  test("an explicit flag wins over the env var", () => {
    process.env.HARNERY_WEB_MAX_OLD_SPACE = "512";
    expect(resolveMaxOldSpaceMb("4096")).toBe(4096);
  });

  test("the env var applies when no flag is passed", () => {
    process.env.HARNERY_WEB_MAX_OLD_SPACE = "512";
    expect(resolveMaxOldSpaceMb(undefined)).toBe(512);
  });

  test("zero opts out, restoring Next's own sizing", () => {
    expect(resolveMaxOldSpaceMb("0")).toBe(0);
  });

  test("a non-numeric or negative value opts out rather than producing a bogus flag", () => {
    expect(resolveMaxOldSpaceMb("banana")).toBe(0);
    expect(resolveMaxOldSpaceMb("-1")).toBe(0);
  });

  test("a fractional value is floored to a whole megabyte", () => {
    expect(resolveMaxOldSpaceMb("1536.9")).toBe(1536);
  });

  test("an empty env var falls through to the default", () => {
    process.env.HARNERY_WEB_MAX_OLD_SPACE = "";
    expect(resolveMaxOldSpaceMb(undefined)).toBe(DEFAULT_MB);
  });
});

describe("nodeOptionsWithHeapCap", () => {
  let savedOpts: string | undefined;

  beforeEach(() => {
    savedOpts = process.env.NODE_OPTIONS;
    delete process.env.NODE_OPTIONS;
  });
  afterEach(() => {
    if (savedOpts === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedOpts;
  });

  test("emits the flag when nothing is inherited", () => {
    expect(nodeOptionsWithHeapCap(2048)).toBe("--max-old-space-size=2048");
  });

  test("appends to inherited options rather than clobbering them", () => {
    process.env.NODE_OPTIONS = "--enable-source-maps";
    expect(nodeOptionsWithHeapCap(2048)).toBe("--enable-source-maps --max-old-space-size=2048");
  });

  test("a caller-supplied ceiling is left alone", () => {
    process.env.NODE_OPTIONS = "--max-old-space-size=8192";
    expect(nodeOptionsWithHeapCap(2048)).toBe("--max-old-space-size=8192");
  });

  test("opting out passes inherited options through untouched", () => {
    process.env.NODE_OPTIONS = "--enable-source-maps";
    expect(nodeOptionsWithHeapCap(0)).toBe("--enable-source-maps");
  });

  test("opting out with nothing inherited leaves NODE_OPTIONS unset", () => {
    expect(nodeOptionsWithHeapCap(0)).toBeUndefined();
  });

  test("adds the web diagnostics preload after inherited Node options", () => {
    process.env.NODE_OPTIONS = "--enable-source-maps";
    const options = nodeOptionsWithWebDiagnostics("/tmp/harnery web", 2048);
    expect(options).toContain("--enable-source-maps --max-old-space-size=2048");
    expect(options).toContain("--import=file:///tmp/harnery%20web/server-performance.mjs");
  });

  test("does not add a duplicate web diagnostics preload", () => {
    process.env.NODE_OPTIONS = "--import=file:///tmp/server-performance.mjs";
    expect(nodeOptionsWithWebDiagnostics("/elsewhere", 0)).toBe(
      "--import=file:///tmp/server-performance.mjs",
    );
  });
});
