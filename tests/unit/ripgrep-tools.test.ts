import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ripgrepAutoInstall } from "../../src/core/config.ts";
import { findRg, hintOncePerDay, managedRgPath, toolsDir } from "../../src/lib/tools/ripgrep.ts";

/** Plant a fake executable that answers `--version` with exit 0. */
function plantFakeRg(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "#!/bin/sh\necho fake-ripgrep 0.0.0\n");
  chmodSync(path, 0o755);
}

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "harnery-rgtools-"));
  for (const k of ["XDG_DATA_HOME", "HARNERY_RG_PATH", "HARNERY_TOOLS_AUTOINSTALL"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ripgrep tools dir + resolution", () => {
  test("toolsDir respects XDG_DATA_HOME", () => {
    process.env.XDG_DATA_HOME = join(tmp, "xdg");
    expect(toolsDir()).toBe(join(tmp, "xdg", "harnery", "tools"));
    expect(managedRgPath()).toBe(join(tmp, "xdg", "harnery", "tools", "rg"));
  });

  test("HARNERY_RG_PATH override wins over managed install", () => {
    process.env.XDG_DATA_HOME = join(tmp, "xdg");
    plantFakeRg(managedRgPath());
    const override = join(tmp, "custom-rg");
    plantFakeRg(override);
    process.env.HARNERY_RG_PATH = override;
    expect(findRg()).toBe(override);
  });

  test("a broken HARNERY_RG_PATH fails loud (null), no silent fallback", () => {
    process.env.HARNERY_RG_PATH = join(tmp, "does-not-exist");
    expect(findRg()).toBeNull();
  });

  test("managed install found before PATH probe", () => {
    process.env.XDG_DATA_HOME = join(tmp, "xdg");
    plantFakeRg(managedRgPath());
    expect(findRg()).toBe(managedRgPath());
  });

  test("hintOncePerDay stamps and suppresses the second call", () => {
    process.env.XDG_DATA_HOME = join(tmp, "xdg");
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      hintOncePerDay("install ripgrep please");
      hintOncePerDay("install ripgrep please");
      expect(writes.filter((w) => w.includes("install ripgrep please"))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("ripgrepAutoInstall config consent", () => {
  function writeConfig(root: string, body: string): void {
    mkdirSync(join(root, ".harnery"), { recursive: true });
    writeFileSync(join(root, ".harnery", "config.jsonc"), body);
  }

  test("absent config → false", () => {
    expect(ripgrepAutoInstall(tmp)).toBe(false);
  });

  test("tools.ripgrep.autoInstall true → true (jsonc comments ok)", () => {
    writeConfig(tmp, `{\n  // consent\n  "tools": { "ripgrep": { "autoInstall": true } }\n}\n`);
    expect(ripgrepAutoInstall(tmp)).toBe(true);
  });

  test("non-boolean / partial shapes → false", () => {
    writeConfig(tmp, `{ "tools": { "ripgrep": { "autoInstall": "yes" } } }`);
    expect(ripgrepAutoInstall(tmp)).toBe(false);
  });

  test("HARNERY_TOOLS_AUTOINSTALL env overrides config both ways", () => {
    writeConfig(tmp, `{ "tools": { "ripgrep": { "autoInstall": true } } }`);
    process.env.HARNERY_TOOLS_AUTOINSTALL = "0";
    expect(ripgrepAutoInstall(tmp)).toBe(false);
    process.env.HARNERY_TOOLS_AUTOINSTALL = "1";
    expect(ripgrepAutoInstall(tmp)).toBe(true);
  });
});
