import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "../cookies/index.ts";
import { fetchWithJar } from "./client.ts";

const realFetch = globalThis.fetch;
const roots: string[] = [];

function responseAt(url: string, body: BodyInit, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fetchWithJar response bodies", () => {
  test("returns text by default", async () => {
    globalThis.fetch = (async () => new Response("café")) as unknown as typeof fetch;

    const result = await fetchWithJar("https://example.com/text");

    expect(result.body).toBe("café");
  });

  test("preserves every response byte in bytes mode", async () => {
    const payload = Uint8Array.from([0x00, 0x7f, 0x80, 0xfe, 0xff]);
    globalThis.fetch = (async () => new Response(payload)) as unknown as typeof fetch;

    const result = await fetchWithJar("https://example.com/file", {
      responseType: "bytes",
    });

    expect(result.body).toEqual(payload);
  });

  test("persists response cookies in bytes mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-fetch-client-"));
    roots.push(root);
    const jar = new CookieJar({ path: join(root, "cookies.json") });
    globalThis.fetch = (async () =>
      responseAt("https://example.com/file", Uint8Array.from([0xff]), {
        headers: { "set-cookie": "session=abc; Path=/; HttpOnly" },
      })) as unknown as typeof fetch;

    const result = await fetchWithJar("https://example.com/file", {
      jar,
      responseType: "bytes",
    });

    expect(result.cookiesSaved).toBe(1);
    expect(jar.list({ domain: "example.com" }).map((cookie) => cookie.name)).toEqual(["session"]);
  });
});
