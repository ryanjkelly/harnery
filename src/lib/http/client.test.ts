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

describe("fetchWithJar extraCookies", () => {
  test("attaches host cookies before building the Cookie header", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-fetch-extra-"));
    roots.push(root);
    const jar = new CookieJar({ path: join(root, "cookies.json") });
    jar.set({
      name: "other",
      value: "1",
      domain: "example.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: false,
      secure: true,
    });

    let cookieHeader = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      cookieHeader = headers.get("cookie") ?? "";
      return responseAt(String(input), "ok");
    }) as unknown as typeof fetch;

    await fetchWithJar("https://example.com/page", {
      jar,
      extraCookies: () => [
        {
          name: "session",
          value: "tok",
          domain: "example.com",
          path: "/",
          expires: Math.floor(Date.now() / 1000) + 3600,
          httpOnly: true,
          secure: true,
        },
      ],
    });

    expect(cookieHeader).toContain("other=1");
    expect(cookieHeader).toContain("session=tok");
    expect(
      jar
        .list({ domain: "example.com" })
        .map((c) => c.name)
        .sort(),
    ).toEqual(["other", "session"]);
  });

  test("skips extraCookies when no jar is passed", async () => {
    let called = false;
    globalThis.fetch = (async () => new Response("ok")) as unknown as typeof fetch;

    await fetchWithJar("https://example.com/page", {
      extraCookies: () => {
        called = true;
        return [];
      },
    });

    expect(called).toBe(false);
  });
});

describe("fetchWithJar clientRedirects", () => {
  test("runs the header callback and cookie persistence for every hop", async () => {
    const seen: { path: string; cookie: string | null }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        seen.push({ path, cookie: request.headers.get("cookie") });
        if (path === "/a") {
          return new Response(null, {
            status: 302,
            headers: { Location: "/b", "Set-Cookie": "hop=a; Path=/" },
          });
        }
        if (path === "/b") {
          return new Response(null, {
            status: 307,
            headers: { Location: "/c", "Set-Cookie": "hop=b; Path=/" },
          });
        }
        return new Response("done");
      },
    });
    const root = mkdtempSync(join(tmpdir(), "harnery-client-redirects-"));
    roots.push(root);
    try {
      const jar = new CookieJar({ path: join(root, "cookies.json") });
      const hops: string[] = [];
      const result = await fetchWithJar(`http://127.0.0.1:${server.port}/a`, {
        jar,
        clientRedirects: true,
        extraHeaders: (url) => {
          hops.push(new URL(url).pathname);
          return {};
        },
      });
      expect(result).toMatchObject({ status: 200, body: "done", cookiesSaved: 2 });
      expect(new URL(result.url).pathname).toBe("/c");
      expect(hops).toEqual(["/a", "/b", "/c"]);
      expect(seen.map((s) => s.cookie)).toEqual([null, "hop=a", "hop=b"]);
    } finally {
      server.stop(true);
    }
  });

  test("a hop callback can stop the chain before the next request", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const path = new URL(request.url).pathname;
        paths.push(path);
        return path === "/a"
          ? new Response(null, { status: 302, headers: { Location: "/stop" } })
          : new Response("reached");
      },
    });
    try {
      await expect(
        fetchWithJar(`http://127.0.0.1:${server.port}/a`, {
          clientRedirects: true,
          extraHeaders: (url) => {
            if (new URL(url).pathname === "/stop") throw new Error("blocked hop");
            return {};
          },
        }),
      ).rejects.toThrow("blocked hop");
      expect(paths).toEqual(["/a"]);
    } finally {
      server.stop(true);
    }
  });

  test("303 switches to GET and a cross-origin hop drops credential headers", async () => {
    const a = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (r) =>
        new Response(JSON.stringify({ method: r.method, auth: r.headers.get("authorization") })),
    });
    const b = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        new Response(null, { status: 303, headers: { Location: `http://127.0.0.1:${a.port}/x` } }),
    });
    try {
      const result = await fetchWithJar(`http://127.0.0.1:${b.port}/p`, {
        method: "POST",
        body: "x",
        headers: { Authorization: "Bearer secret" },
        clientRedirects: true,
      });
      expect(JSON.parse(result.body)).toEqual({ method: "GET", auth: null });
    } finally {
      a.stop(true);
      b.stop(true);
    }
  });
});

describe("fetchWithJar host-only cookies", () => {
  function serve(handler: (request: Request) => Response) {
    return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
  }

  test("a host-only cookie is not sent to a subdomain on a redirect, with or without clientRedirects", async () => {
    const seen: (string | null)[] = [];
    const target = serve((request) => {
      seen.push(request.headers.get("cookie"));
      return new Response("target");
    });
    const origin = serve(
      () =>
        new Response(null, {
          status: 302,
          headers: { Location: `http://evil.app.localhost:${target.port}/x` },
        }),
    );
    const root = mkdtempSync(join(tmpdir(), "harnery-host-only-"));
    roots.push(root);
    try {
      for (const clientRedirects of [undefined, true, false]) {
        seen.length = 0;
        const jar = new CookieJar({ path: join(root, `cookies-${String(clientRedirects)}.json`) });
        jar.set({
          name: "__Host-session",
          value: "secret",
          domain: "app.localhost",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
        });
        const result = await fetchWithJar(`http://app.localhost:${origin.port}/start`, {
          jar,
          ...(clientRedirects === undefined ? {} : { clientRedirects }),
        });
        expect(result.body).toBe("target");
        expect(new URL(result.url).hostname).toBe("evil.app.localhost");
        expect(seen).toEqual([null]);
      }
    } finally {
      origin.stop(true);
      target.stop(true);
    }
  });

  test("a host-only cookie follows a redirect that stays on its host", async () => {
    const seen: (string | null)[] = [];
    const server = serve((request) => {
      const path = new URL(request.url).pathname;
      seen.push(request.headers.get("cookie"));
      return path === "/a"
        ? new Response(null, { status: 302, headers: { Location: "/b" } })
        : new Response("b");
    });
    const root = mkdtempSync(join(tmpdir(), "harnery-host-only-same-"));
    roots.push(root);
    try {
      const jar = new CookieJar({ path: join(root, "cookies.json") });
      jar.set({
        name: "__Host-session",
        value: "secret",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      });
      await fetchWithJar(`http://127.0.0.1:${server.port}/a`, { jar });
      expect(seen).toEqual(["__Host-session=secret", "__Host-session=secret"]);
    } finally {
      server.stop(true);
    }
  });

  test("Set-Cookie rules: foreign Domain and broken prefixes are dropped, host-only is kept host-only", async () => {
    const server = serve(() => {
      const headers = new Headers();
      headers.append("Set-Cookie", "__Host-ok=1; Path=/; Secure; HttpOnly");
      headers.append("Set-Cookie", "__Host-wide=1; Path=/; Secure; Domain=127.0.0.1");
      headers.append("Set-Cookie", "__Host-insecure=1; Path=/");
      headers.append("Set-Cookie", "__Secure-insecure=1; Path=/");
      headers.append("Set-Cookie", "foreign=1; Path=/; Domain=other.test");
      headers.append("Set-Cookie", "plain=1; Path=/");
      return new Response("ok", { headers });
    });
    const root = mkdtempSync(join(tmpdir(), "harnery-set-cookie-rules-"));
    roots.push(root);
    try {
      const jar = new CookieJar({ path: join(root, "cookies.json") });
      const result = await fetchWithJar(`http://127.0.0.1:${server.port}/`, { jar });
      expect(result.cookiesSaved).toBe(2);
      expect(jar.list().map((c) => `${c.name}@${c.domain}`)).toEqual([
        "__Host-ok@127.0.0.1",
        "plain@127.0.0.1",
      ]);
    } finally {
      server.stop(true);
    }
  });

  test("a legacy Domain cookie clear on a redirect hop reaches the jar", async () => {
    const server = serve((request) => {
      const path = new URL(request.url).pathname;
      if (path === "/a") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/b", "Set-Cookie": "old=; Path=/; Max-Age=0" },
        });
      }
      return new Response("b");
    });
    const root = mkdtempSync(join(tmpdir(), "harnery-hop-clear-"));
    roots.push(root);
    try {
      const jar = new CookieJar({ path: join(root, "cookies.json") });
      jar.set({
        name: "old",
        value: "x",
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
      });
      await fetchWithJar(`http://127.0.0.1:${server.port}/a`, { jar });
      expect(jar.list().map((c) => c.name)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
