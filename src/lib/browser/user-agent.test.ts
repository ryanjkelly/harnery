import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  hostFamily,
  normalUserAgent,
  parseChromeMajor,
  readStoredUserAgent,
  resolveUserAgent,
} from "./user-agent.ts";

const tmpStore = () => join(mkdtempSync(join(tmpdir(), "harnery-ua-")), "user-agent.json");

describe("user agent", () => {
  test("linux and win32 present as Windows, darwin as mac", () => {
    expect(hostFamily("linux")).toBe("windows");
    expect(hostFamily("win32")).toBe("windows");
    expect(hostFamily("darwin")).toBe("mac");
  });

  test("normal UA never mentions Linux or headless", () => {
    const ua = normalUserAgent(152, "windows");
    expect(ua).toContain("Windows NT 10.0");
    expect(ua).toContain("Chrome/152.0.0.0");
    expect(ua).not.toMatch(/Linux|Headless/);
    expect(normalUserAgent(152, "mac")).toContain("Macintosh");
  });

  test("parses the major from chrome --version output", () => {
    expect(parseChromeMajor("Google Chrome 152.0.7977.75 ")).toBe(152);
    expect(parseChromeMajor("garbage")).toBeUndefined();
  });

  test("auto resolve writes the store and reuses it", () => {
    const storePath = tmpStore();
    const first = resolveUserAgent({ chromeMajor: 152, platform: "linux", storePath });
    expect(first).toContain("Chrome/152.0.0.0");
    expect(readStoredUserAgent(storePath)?.source).toBe("auto");
    const again = resolveUserAgent({ chromeMajor: 152, platform: "linux", storePath });
    expect(again).toBe(first);
  });

  test("a moved Chrome major refreshes an auto value", () => {
    const storePath = tmpStore();
    resolveUserAgent({ chromeMajor: 149, platform: "linux", storePath });
    const next = resolveUserAgent({ chromeMajor: 152, platform: "linux", storePath });
    expect(next).toContain("Chrome/152.0.0.0");
  });

  test("explicit request rewrites the store as manual; native disables", () => {
    const storePath = tmpStore();
    expect(resolveUserAgent({ requested: "Custom/1.0", storePath })).toBe("Custom/1.0");
    expect(JSON.parse(readFileSync(storePath, "utf8")).source).toBe("manual");
    expect(resolveUserAgent({ chromeMajor: 200, platform: "linux", storePath })).toBe("Custom/1.0");
    expect(resolveUserAgent({ requested: "native", storePath })).toBeUndefined();
    expect(
      resolveUserAgent({ requested: "auto", chromeMajor: 152, platform: "linux", storePath }),
    ).toContain("Chrome/152.0.0.0");
  });

  test("environment overrides the store", () => {
    const storePath = tmpStore();
    resolveUserAgent({ chromeMajor: 152, platform: "linux", storePath });
    expect(resolveUserAgent({ env: "EnvUA/2", storePath })).toBe("EnvUA/2");
    expect(resolveUserAgent({ env: "native", storePath })).toBeUndefined();
  });
});
