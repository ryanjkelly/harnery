import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { nodeOptionsWithHeapCap, resolveMaxOldSpaceMb } from "./web.ts";

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
});
