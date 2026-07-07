import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BIN_NAME, resolveBinName, stripJsonComments } from "./config.ts";

function makeRoot(configBody?: string): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-config-"));
  mkdirSync(join(root, ".harnery"), { recursive: true });
  if (configBody !== undefined) {
    writeFileSync(join(root, ".harnery", "config.jsonc"), configBody);
  }
  return root;
}

describe("resolveBinName", () => {
  const roots: string[] = [];
  const savedBin = process.env.HARNERY_BIN;

  beforeEach(() => {
    // env vars must be unset, not set to the string "undefined"
    delete process.env.HARNERY_BIN;
  });
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    if (savedBin === undefined) {
      // env vars must be unset, not set to the string "undefined"
      delete process.env.HARNERY_BIN;
    } else {
      process.env.HARNERY_BIN = savedBin;
    }
  });

  test("HARNERY_BIN env wins over config + default", () => {
    process.env.HARNERY_BIN = "envbin";
    const root = makeRoot(`{ "binName": "cfgbin" }`);
    roots.push(root);
    expect(resolveBinName(root)).toBe("envbin");
  });

  test("reads binName from config.jsonc when no env", () => {
    const root = makeRoot(`{ "binName": "acme" }`);
    roots.push(root);
    expect(resolveBinName(root)).toBe("acme");
  });

  test("parses JSONC with comments", () => {
    const root = makeRoot(`{\n  // host CLI\n  "binName": "myapp"\n}`);
    roots.push(root);
    expect(resolveBinName(root)).toBe("myapp");
  });

  test("falls back to harn when config has no binName", () => {
    const root = makeRoot(`{ "files": { "deny_globs": [] } }`);
    roots.push(root);
    expect(resolveBinName(root)).toBe(DEFAULT_BIN_NAME);
  });

  test("falls back to harn when config.jsonc is absent", () => {
    const root = makeRoot();
    roots.push(root);
    expect(resolveBinName(root)).toBe(DEFAULT_BIN_NAME);
  });

  test("falls back to harn when config.jsonc is unparseable", () => {
    const root = makeRoot(`{ "binName": `);
    roots.push(root);
    expect(resolveBinName(root)).toBe(DEFAULT_BIN_NAME);
  });
});

describe("stripJsonComments", () => {
  test("leaves comment-like runs inside strings alone", () => {
    const out = stripJsonComments(`{ "url": "http://x/y", "n": 1 /* c */ }`);
    expect(JSON.parse(out)).toEqual({ url: "http://x/y", n: 1 });
  });
});
