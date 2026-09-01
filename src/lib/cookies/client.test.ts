import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar, CookieStoreParseError } from "./client.ts";

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
