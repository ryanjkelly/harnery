import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
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

  for (const [encoding, compress] of [
    ["gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const) {
    test(`preserves ${encoding}-encoded representation bytes and matching headers`, async () => {
      const decoded = new TextEncoder().encode(`encoded with ${encoding}\n`);
      const encoded = new Uint8Array(compress(decoded));
      const acceptEncodings: Array<string | null> = [];
      const server = Bun.serve({
        port: 0,
        fetch(request) {
          acceptEncodings.push(request.headers.get("accept-encoding"));
          return new Response(encoded, {
            headers: {
              "content-encoding": encoding,
              "content-length": String(encoded.byteLength),
            },
          });
        },
      });

      try {
        const result = await fetchWithJar(`${server.url}encoded`, {
          responseType: "bytes",
        });

        expect(result.body).toEqual(encoded);
        expect(result.headers["content-encoding"]).toBe(encoding);
        expect(result.headers["content-length"]).toBe(String(encoded.byteLength));
        expect(acceptEncodings[0]).toBe("identity");
      } finally {
        server.stop(true);
      }
    });
  }

  test("keeps automatic decompression for text responses", async () => {
    const decoded = "decoded text\n";
    const encoded = gzipSync(decoded);
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(encoded, {
          headers: { "content-encoding": "gzip" },
        });
      },
    });

    try {
      const result = await fetchWithJar(`${server.url}text`);
      expect(result.body).toBe(decoded);
    } finally {
      server.stop(true);
    }
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
