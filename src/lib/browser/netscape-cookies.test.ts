import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "playwright";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import { serializeNetscapeCookies, writeNetscapeCookieFile } from "./netscape-cookies.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) removeDir(path);
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

  function writeFixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "harn-cookies-"));
    tempDirs.push(dir);
    const path = join(dir, "nested", "cookies.txt");
    writeNetscapeCookieFile(path, [cookie]);
    return path;
  }

  test("writes the cookie file into a new nested directory", () => {
    expect(readFileSync(writeFixture(), "utf8")).toContain("SID\tsecret-value");
  });

  // Windows has no POSIX mode bits to check, so this is skipped there, not passed.
  test.skipIf(process.platform === "win32")(
    "writes credential-bearing output with owner-only permissions",
    () => {
      expect(statSync(writeFixture()).mode & 0o777).toBe(0o600);
    },
  );
});
