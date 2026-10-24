import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Cookie,
  CookieJar,
  CookieStoreParseError,
  cookieSendsToHost,
  matchingCookies,
  violatesCookiePrefix,
} from "./client.ts";

function storePath(): string {
  return join(mkdtempSync(join(tmpdir(), "harnery-cookie-store-")), "cookies.json");
}

describe("CookieJar persistence", () => {
  test("reports a stable malformed store with its path and preserves the evidence", () => {
    const path = storePath();
    const malformed = Buffer.from('{"cookies":[\u0000]}\n');
    writeFileSync(path, malformed);
    const jar = new CookieJar({ path });

    let error: unknown;
    try {
      jar.load();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CookieStoreParseError);
    expect((error as Error).message).toContain(`Cookie-store parse failed at "${path}"`);
    expect((error as Error).message).toContain("after a stable read");
    expect((error as Error).message).toContain("left unchanged");
    expect(readFileSync(path)).toEqual(malformed);
  });

  test("atomically replaces a complete store without leaving write artifacts", () => {
    const path = storePath();
    const jar = new CookieJar({ path, source: "test" });
    jar.save({ cookies: [], origins: [] });

    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
    expect(readFileSync(path, "utf8")).toContain('"exportedFrom": "test"');
  });
});

function cookie(overrides: Partial<Cookie>): Cookie {
  return {
    name: "session",
    value: "v",
    domain: "app.example.test",
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    ...overrides,
  };
}

describe("cookie delivery host rules", () => {
  test("a host-only cookie goes to its exact host and no other host", () => {
    const domain = "app.example.test";
    expect(cookieSendsToHost(domain, "app.example.test")).toBe(true);
    expect(cookieSendsToHost(domain, "APP.example.test")).toBe(true);
    expect(cookieSendsToHost(domain, "evil.app.example.test")).toBe(false);
    expect(cookieSendsToHost(domain, "example.test")).toBe(false);
    expect(cookieSendsToHost(domain, "share.example.test")).toBe(false);
    expect(cookieSendsToHost(domain, "xapp.example.test")).toBe(false);
    expect(cookieSendsToHost(domain, "app.example.test.evil.test")).toBe(false);
  });

  test("a domain cookie goes to the domain and its subdomains only", () => {
    const domain = ".example.test";
    expect(cookieSendsToHost(domain, "example.test")).toBe(true);
    expect(cookieSendsToHost(domain, "app.example.test")).toBe(true);
    expect(cookieSendsToHost(domain, "a.b.example.test")).toBe(true);
    expect(cookieSendsToHost(domain, "badexample.test")).toBe(false);
  });

  test("matchingCookies applies the exact-host rule with path and Secure", () => {
    const store = {
      cookies: [
        cookie({ name: "__Host-acme_session", domain: "app.example.test" }),
        cookie({ name: "wide", domain: ".example.test" }),
        cookie({ name: "other", domain: "share.example.test" }),
      ],
      origins: [],
    };
    const names = (url: string) => matchingCookies(store, url).map((c) => c.name);
    expect(names("https://app.example.test/page")).toEqual(["__Host-acme_session", "wide"]);
    expect(names("https://evil.app.example.test/")).toEqual(["wide"]);
    expect(names("https://share.example.test/")).toEqual(["wide", "other"]);
    expect(names("https://vendor.test/")).toEqual([]);
    // Secure cookies stay off plain HTTP, except to loopback hosts as in browsers.
    expect(names("http://app.example.test/")).toEqual([]);
  });

  test("a Secure host-only cookie reaches a loopback host over HTTP but not its subdomains", () => {
    const store = { cookies: [cookie({ name: "s", domain: "app.localhost" })], origins: [] };
    expect(matchingCookies(store, "http://app.localhost:3000/").length).toBe(1);
    expect(matchingCookies(store, "http://evil.app.localhost:3000/").length).toBe(0);
    expect(matchingCookies(store, "http://localhost:3000/").length).toBe(0);
  });

  test("jar.header() carries the same exact-host rule", () => {
    const jar = new CookieJar({ path: storePath() });
    jar.set(cookie({ name: "__Host-acme_session", value: "tok", domain: "app.example.test" }));
    expect(jar.header("https://app.example.test/x")).toBe("__Host-acme_session=tok");
    expect(jar.header("https://evil.app.example.test/x")).toBe("");
    expect(jar.header("https://example.test/x")).toBe("");
  });
});

describe("cookie name prefixes", () => {
  test("__Host- needs Secure, Path=/ and a host-only domain", () => {
    expect(violatesCookiePrefix(cookie({ name: "__Host-a" }))).toBe(false);
    expect(violatesCookiePrefix(cookie({ name: "__Host-a", domain: ".example.test" }))).toBe(true);
    expect(violatesCookiePrefix(cookie({ name: "__Host-a", secure: false }))).toBe(true);
    expect(violatesCookiePrefix(cookie({ name: "__Host-a", path: "/app" }))).toBe(true);
  });

  test("__Secure- needs Secure; other names are unconstrained", () => {
    expect(violatesCookiePrefix(cookie({ name: "__Secure-a" }))).toBe(false);
    expect(violatesCookiePrefix(cookie({ name: "__Secure-a", secure: false }))).toBe(true);
    expect(violatesCookiePrefix(cookie({ name: "plain", secure: false, domain: ".x.test" }))).toBe(
      false,
    );
  });
});
