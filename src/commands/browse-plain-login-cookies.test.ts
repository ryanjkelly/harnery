import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "../lib/cookies/index.ts";
import { type PlainLoginCookieDeps, syncPlainLoginCookies } from "./browse.ts";

type ProfileCookie = Awaited<ReturnType<PlainLoginCookieDeps["readProfileCookies"]>>[number];

function cookie(name: string, domain: string, expires = 2_000_000_000): ProfileCookie {
  return {
    name,
    value: `${name}-value`,
    domain,
    path: "/",
    expires,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };
}

const PROFILE = [
  cookie("auth", ".example.com"),
  cookie("sid", "www.example.com", -1),
  cookie("acct", "accounts.example.com"),
  cookie("idp", ".identity-provider.test"),
  cookie("lookalike", "notexample.com"),
];

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harnery-plain-login-"));
  storePath = join(dir, "cookies.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function reader(...results: (ProfileCookie[] | Error)[]) {
  const calls: string[] = [];
  const deps: PlainLoginCookieDeps = {
    readProfileCookies: async (profileDir) => {
      calls.push(profileDir);
      const next = results.shift();
      if (next === undefined || next instanceof Error) throw next ?? new Error("no more reads");
      return next;
    },
    sleep: async () => {},
  };
  return { deps, calls };
}

describe("syncPlainLoginCookies", () => {
  test("copies only the sign-in site's registrable domain into the store", async () => {
    const seeded = new CookieJar({ path: storePath, source: "test" });
    seeded.save({ ...seeded.load(), cookies: [cookie("kept", "other.test")] });
    const { deps, calls } = reader([...PROFILE]);

    const result = await syncPlainLoginCookies({
      url: "https://www.example.com/login",
      profileDir: "/profiles/browse",
      storePath,
      deps,
      env: {},
    });

    expect(calls).toEqual(["/profiles/browse"]);
    expect(result).toEqual({
      status: "copied",
      domain: "example.com",
      cookies: 3,
      sessionCookies: 1,
      names: ["acct", "auth", "sid"],
    });
    const stored = new CookieJar({ path: storePath, source: "test" })
      .load()
      .cookies.map((c) => `${c.name}@${c.domain}`)
      .sort();
    expect(stored).toEqual([
      "acct@accounts.example.com",
      "auth@.example.com",
      "kept@other.test",
      "sid@www.example.com",
    ]);
  });

  test("a later sign-in replaces the stored copy of the same cookie", async () => {
    const seeded = new CookieJar({ path: storePath, source: "test" });
    seeded.save({
      ...seeded.load(),
      cookies: [{ ...cookie("auth", ".example.com"), value: "old" }],
    });
    const { deps } = reader([cookie("auth", ".example.com")]);

    await syncPlainLoginCookies({
      url: "https://example.com/",
      profileDir: "/p",
      storePath,
      deps,
      env: {},
    });

    const stored = new CookieJar({ path: storePath, source: "test" }).load().cookies;
    expect(stored).toHaveLength(1);
    expect(stored[0]?.value).toBe("auth-value");
  });

  test("HARNERY_BROWSER_LOGIN_SYNC=off reads nothing and leaves the store alone", async () => {
    const { deps, calls } = reader([...PROFILE]);

    const result = await syncPlainLoginCookies({
      url: "https://example.com/",
      profileDir: "/p",
      storePath,
      deps,
      env: { HARNERY_BROWSER_LOGIN_SYNC: "OFF" },
    });

    expect(result).toEqual({ status: "off" });
    expect(calls).toEqual([]);
    expect(existsSync(storePath)).toBe(false);
  });

  test("a read that fails while Chrome releases the profile is retried once", async () => {
    const delays: number[] = [];
    const { deps, calls } = reader(new Error("profile in use"), [cookie("auth", ".example.com")]);
    deps.sleep = async (ms) => {
      delays.push(ms);
    };

    const result = await syncPlainLoginCookies({
      url: "https://example.com/",
      profileDir: "/p",
      storePath,
      deps,
      env: {},
      retryDelayMs: 50,
    });

    expect(calls).toHaveLength(2);
    expect(delays).toEqual([50]);
    expect(result.status).toBe("copied");
  });

  test("a read that keeps failing is reported, not thrown, and the store is untouched", async () => {
    const { deps, calls } = reader(new Error("first"), new Error("Chrome would not start"));

    const result = await syncPlainLoginCookies({
      url: "https://example.com/",
      profileDir: "/p",
      storePath,
      deps,
      env: {},
    });

    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      status: "failed",
      domain: "example.com",
      error: "Chrome would not start",
    });
    expect(existsSync(storePath)).toBe(false);
  });

  test("no cookies for the site reports none and writes nothing", async () => {
    const { deps } = reader([cookie("idp", ".identity-provider.test")]);

    const result = await syncPlainLoginCookies({
      url: "https://example.com/",
      profileDir: "/p",
      storePath,
      deps,
      env: {},
    });

    expect(result).toEqual({
      status: "none",
      domain: "example.com",
      cookies: 0,
      sessionCookies: 0,
      names: [],
    });
    expect(existsSync(storePath)).toBe(false);
  });
});
