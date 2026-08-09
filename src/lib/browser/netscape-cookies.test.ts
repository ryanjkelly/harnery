import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "playwright";
import { serializeNetscapeCookies, writeNetscapeCookieFile } from "./netscape-cookies.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

const cookie: Cookie = {
  name: "SID",
  value: "secret-value",
  domain: ".youtube.com",
  path: "/",
  expires: 1_900_000_000.9,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
};

describe("Netscape cookie export", () => {
  test("serializes HttpOnly, subdomain, secure, and expiry fields", () => {
    const output = serializeNetscapeCookies([cookie]);
    expect(output).toContain("# Netscape HTTP Cookie File");
    expect(output).toContain(
      "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tsecret-value",
    );
  });

  test("writes credential-bearing output with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "harn-cookies-"));
    tempDirs.push(dir);
    const path = join(dir, "nested", "cookies.txt");
    writeNetscapeCookieFile(path, [cookie]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("SID\tsecret-value");
  });
});
