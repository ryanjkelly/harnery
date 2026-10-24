import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "../cookies/client.ts";
import { parseRunningOutput, runningScript, windowsPathToWsl } from "./windows-chrome.ts";
import {
  cookieFingerprint,
  decideLoginSync,
  type LoginSyncDeps,
  loginSyncStatePath,
  profileCookieDbMtimeMs,
  readLoginSyncState,
  recordLoginSync,
  syncLoginCookies,
  writeLoginSyncState,
} from "./windows-login-sync.ts";

function cookie(name: string, value: string, expires = 2_000_000_000): Cookie {
  return {
    name,
    value,
    domain: ".example.com",
    path: "/",
    expires,
    httpOnly: true,
    secure: true,
  };
}

function storeDir(): string {
  return mkdtempSync(join(tmpdir(), "login-sync-"));
}

function fakeDeps(input: {
  mtimes: (number | undefined)[];
  processes?: number[];
  cookies?: Cookie[];
}): LoginSyncDeps & { calls: { harvest: number; running: number } } {
  const calls = { harvest: 0, running: 0 };
  let tick = 0;
  return {
    calls,
    cookieDbMtimeMs: () => input.mtimes[Math.min(tick++, input.mtimes.length - 1)],
    profileProcesses: () => {
      calls.running++;
      return input.processes ?? [];
    },
    harvest: () => {
      calls.harvest++;
      return { cookies: input.cookies ?? [], pages: [] };
    },
    now: () => new Date("2026-01-02T03:04:05Z"),
  };
}

describe("decideLoginSync", () => {
  const record = { syncedAt: "x", cookieDbMtimeMs: 100, fingerprint: "f", cookies: 1 };

  test("no cookie database means no profile", () => {
    expect(decideLoginSync({ cookieDbMtimeMs: undefined, record, running: () => false })).toBe(
      "no-profile",
    );
  });

  test("an older or equal database is current and never checks for Chrome", () => {
    let checked = false;
    const running = () => {
      checked = true;
      return true;
    };
    expect(decideLoginSync({ cookieDbMtimeMs: 90, record, running })).toBe("current");
    expect(decideLoginSync({ cookieDbMtimeMs: 100, record, running })).toBe("current");
    expect(checked).toBe(false);
  });

  test("a newer database syncs when closed and waits when open", () => {
    expect(decideLoginSync({ cookieDbMtimeMs: 101, record, running: () => false })).toBe("sync");
    expect(decideLoginSync({ cookieDbMtimeMs: 101, record, running: () => true })).toBe("open");
  });

  test("a domain never copied syncs", () => {
    expect(decideLoginSync({ cookieDbMtimeMs: 1, record: undefined, running: () => false })).toBe(
      "sync",
    );
  });

  test("force skips the time check but never an open profile", () => {
    expect(
      decideLoginSync({ cookieDbMtimeMs: 50, record, running: () => false, force: true }),
    ).toBe("sync");
    expect(decideLoginSync({ cookieDbMtimeMs: 50, record, running: () => true, force: true })).toBe(
      "open",
    );
  });
});

describe("sync state file", () => {
  test("lives beside the cookie store", () => {
    expect(loginSyncStatePath("/a/b/cookies.json")).toBe("/a/b/cookies.login-sync.json");
    expect(loginSyncStatePath("/a/store")).toBe("/a/store.login-sync.json");
  });

  test("round-trips owner-only and tolerates a missing or corrupt file", () => {
    const dir = storeDir();
    const path = join(dir, "nested", "cookies.login-sync.json");
    expect(readLoginSyncState(path)).toEqual({ version: 1, domains: {} });
    const state = {
      version: 1 as const,
      domains: {
        "example.com": { syncedAt: "t", cookieDbMtimeMs: 5, fingerprint: "f", cookies: 2 },
      },
    };
    writeLoginSyncState(path, state);
    expect(readLoginSyncState(path)).toEqual(state);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, "not json");
    expect(readLoginSyncState(path)).toEqual({ version: 1, domains: {} });
  });

  test("records hashes, never cookie values", () => {
    const dir = storeDir();
    const storePath = join(dir, "cookies.json");
    recordLoginSync({
      domain: "example.com",
      storePath,
      cookies: [cookie("sid", "secret-value")],
      cookieDbMtimeMs: 7,
    });
    const raw = readFileSync(loginSyncStatePath(storePath), "utf8");
    expect(raw).not.toContain("secret-value");
    expect(readLoginSyncState(loginSyncStatePath(storePath)).domains["example.com"]).toMatchObject({
      cookieDbMtimeMs: 7,
      cookies: 1,
    });
  });

  test("fingerprints ignore order and change with a value", () => {
    const a = cookie("a", "1");
    const b = cookie("b", "2");
    expect(cookieFingerprint([a, b])).toBe(cookieFingerprint([b, a]));
    expect(cookieFingerprint([a, b])).not.toBe(cookieFingerprint([a, cookie("b", "3")]));
  });
});

describe("syncLoginCookies", () => {
  test("reports no profile without reading or checking anything", () => {
    const dir = storeDir();
    const deps = fakeDeps({ mtimes: [undefined] });
    const result = syncLoginCookies({
      domain: "example.com",
      storePath: join(dir, "c.json"),
      deps,
    });
    expect(result.status).toBe("no-profile");
    expect(deps.calls).toEqual({ harvest: 0, running: 0 });
  });

  test("copies a changed, closed profile into the store and records it", () => {
    const dir = storeDir();
    const storePath = join(dir, "c.json");
    const deps = fakeDeps({
      mtimes: [100, 140],
      cookies: [cookie("user_session", "v1"), cookie("tmp", "s", -1)],
    });
    const result = syncLoginCookies({ domain: "example.com", storePath, deps });
    expect(result).toMatchObject({
      status: "synced",
      merged: 2,
      sessionCookies: 1,
      names: ["tmp", "user_session"],
    });
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    expect(store.cookies.map((c: Cookie) => c.name).sort()).toEqual(["tmp", "user_session"]);
    const record = readLoginSyncState(loginSyncStatePath(storePath)).domains["example.com"];
    // The time after the read is recorded: the read itself touches the database.
    expect(record?.cookieDbMtimeMs).toBe(140);
    expect(record?.syncedAt).toBe("2026-01-02T03:04:05.000Z");
  });

  test("a database no newer than the record does nothing", () => {
    const dir = storeDir();
    const storePath = join(dir, "c.json");
    recordLoginSync({ domain: "example.com", storePath, cookies: [], cookieDbMtimeMs: 200 });
    const deps = fakeDeps({ mtimes: [200] });
    expect(syncLoginCookies({ domain: "example.com", storePath, deps }).status).toBe("current");
    expect(deps.calls).toEqual({ harvest: 0, running: 0 });
    expect(existsSync(storePath)).toBe(false);
  });

  test("an open profile is left alone and its processes reported", () => {
    const dir = storeDir();
    const storePath = join(dir, "c.json");
    const deps = fakeDeps({ mtimes: [300], processes: [11, 12], cookies: [cookie("a", "1")] });
    const result = syncLoginCookies({ domain: "example.com", storePath, deps });
    expect(result).toMatchObject({ status: "open", processes: [11, 12] });
    expect(deps.calls.harvest).toBe(0);
    expect(existsSync(storePath)).toBe(false);
    expect(existsSync(loginSyncStatePath(storePath))).toBe(false);
  });

  test("the same cookies as last time are not merged over newer store cookies", () => {
    const dir = storeDir();
    const storePath = join(dir, "c.json");
    const profileCookie = cookie("sid", "old");
    recordLoginSync({
      domain: "example.com",
      storePath,
      cookies: [profileCookie],
      cookieDbMtimeMs: 10,
    });
    writeFileSync(
      storePath,
      JSON.stringify({ cookies: [cookie("sid", "refreshed")], origins: [] }),
    );
    const deps = fakeDeps({ mtimes: [20, 25], cookies: [profileCookie] });
    const result = syncLoginCookies({ domain: "example.com", storePath, deps });
    expect(result).toMatchObject({ status: "unchanged", cookies: 1, merged: 0 });
    expect(JSON.parse(readFileSync(storePath, "utf8")).cookies[0].value).toBe("refreshed");
    expect(
      readLoginSyncState(loginSyncStatePath(storePath)).domains["example.com"]?.cookieDbMtimeMs,
    ).toBe(25);
  });

  test("force merges even an unchanged read", () => {
    const dir = storeDir();
    const storePath = join(dir, "c.json");
    const profileCookie = cookie("sid", "profile");
    recordLoginSync({
      domain: "example.com",
      storePath,
      cookies: [profileCookie],
      cookieDbMtimeMs: 10,
    });
    writeFileSync(storePath, JSON.stringify({ cookies: [cookie("sid", "store")], origins: [] }));
    const deps = fakeDeps({ mtimes: [5, 6], cookies: [profileCookie] });
    const result = syncLoginCookies({ domain: "example.com", storePath, deps, force: true });
    expect(result.status).toBe("synced");
    expect(JSON.parse(readFileSync(storePath, "utf8")).cookies[0].value).toBe("profile");
  });

  test("a held lock makes a concurrent sync step aside", () => {
    const dir = storeDir();
    const storePath = join(dir, "c.json");
    writeFileSync(`${loginSyncStatePath(storePath)}.lock`, "");
    const deps = fakeDeps({ mtimes: [5], cookies: [cookie("a", "1")] });
    expect(syncLoginCookies({ domain: "example.com", storePath, deps }).status).toBe("busy");
    expect(deps.calls.harvest).toBe(0);
  });

  test("a read failure propagates and releases the lock", () => {
    const dir = storeDir();
    const storePath = join(dir, "c.json");
    const deps: LoginSyncDeps = {
      cookieDbMtimeMs: () => 5,
      profileProcesses: () => [],
      harvest: () => {
        throw new Error("Chrome is still running on the sign-in profile");
      },
    };
    expect(() => syncLoginCookies({ domain: "example.com", storePath, deps })).toThrow(
      "still running",
    );
    expect(existsSync(`${loginSyncStatePath(storePath)}.lock`)).toBe(false);
  });
});

describe("profile helpers", () => {
  test("reads the newest cookie database location", () => {
    const times: Record<string, number> = {
      "/p/Default/Network/Cookies": 50,
      "/p/Default/Cookies": 70,
    };
    expect(profileCookieDbMtimeMs("/p", (path) => times[path])).toBe(70);
    expect(profileCookieDbMtimeMs("/p", () => undefined)).toBeUndefined();
  });

  test("maps a Windows profile path to its WSL mount", () => {
    expect(windowsPathToWsl("C:\\Users\\a\\AppData\\Local\\harnery\\plain-login-profile")).toBe(
      "/mnt/c/Users/a/AppData/Local/harnery/plain-login-profile",
    );
    expect(windowsPathToWsl("D:\\")).toBe("/mnt/d");
    expect(() => windowsPathToWsl("/home/a")).toThrow();
  });

  test("the running check only lists processes", () => {
    const script = runningScript();
    expect(script).toContain("Get-ProfileChrome");
    expect(script).not.toContain("Stop-Process");
    expect(script).not.toContain("CloseMainWindow");
    expect(parseRunningOutput("[]")).toEqual([]);
    expect(parseRunningOutput("")).toEqual([]);
    expect(parseRunningOutput("42")).toEqual([42]);
    expect(parseRunningOutput("[1,2]")).toEqual([1, 2]);
  });
});
