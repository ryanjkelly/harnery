import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Cookie, CookieJar } from "./client.ts";
import { applyExtraCookies } from "./extra.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function jar(): CookieJar {
  const root = mkdtempSync(join(tmpdir(), "harnery-extra-cookies-"));
  roots.push(root);
  return new CookieJar({ path: join(root, "cookies.json") });
}

function cookie(name: string, value: string, domain = "example.com"): Cookie {
  return {
    name,
    value,
    domain,
    path: "/",
    expires: Math.floor(Date.now() / 1000) + 3600,
    httpOnly: true,
    secure: true,
    session: false,
    sameSite: "Lax",
  };
}

describe("applyExtraCookies", () => {
  test("no-ops when the callback is omitted", () => {
    const store = jar();
    expect(applyExtraCookies("https://example.com/", store)).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  test("persists returned cookies onto the jar", () => {
    const store = jar();
    const minted = cookie("session", "tok");
    const applied = applyExtraCookies("https://example.com/", store, () => [minted]);
    expect(applied).toEqual([minted]);
    expect(store.list({ domain: "example.com" }).map((c) => `${c.name}=${c.value}`)).toEqual([
      "session=tok",
    ]);
  });

  test("lets the callback read cookies already in the jar", () => {
    const store = jar();
    store.set(cookie("existing", "1"));
    let sawExisting = false;
    applyExtraCookies("https://example.com/", store, (_url, current) => {
      sawExisting = current.list({ domain: "example.com" }).some((c) => c.name === "existing");
      return [];
    });
    expect(sawExisting).toBe(true);
  });
});
