import { describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { middleware } from "../middleware";
import { checkWriteOrigin, isStateChangingMethod } from "./write-origin";

const h = (values: Record<string, string>) => new Headers(values);

describe("checkWriteOrigin", () => {
  test("the dashboard's own fetch passes, directly and through a tunnel", () => {
    expect(
      checkWriteOrigin(
        h({
          host: "localhost:4392",
          origin: "http://localhost:4392",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toEqual({ ok: true });
    expect(
      checkWriteOrigin(
        h({
          host: "localhost:4392",
          "x-forwarded-host": "words-here.trycloudflare.com",
          origin: "https://words-here.trycloudflare.com",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toEqual({ ok: true });
  });

  test("non-browser clients without origin headers pass", () => {
    expect(checkWriteOrigin(h({ host: "localhost:4392" }))).toEqual({ ok: true });
  });

  test("cross-site, other-port, files-origin, and null origins are refused", () => {
    const cases: Array<Record<string, string>> = [
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      { "sec-fetch-site": "same-site", origin: "http://localhost:3000" },
      { origin: "http://localhost:3000" },
      { origin: "http://harnery-files.localhost:4392" },
      { origin: "null" },
      { origin: "file://" },
    ];
    for (const extra of cases) {
      expect(checkWriteOrigin(h({ host: "localhost:4392", ...extra })).ok).toBe(false);
    }
  });

  test("only state-changing methods are checked", () => {
    expect(["GET", "head", "OPTIONS"].map(isStateChangingMethod)).toEqual([false, false, false]);
    expect(["POST", "PUT", "patch", "DELETE"].map(isStateChangingMethod)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });
});

describe("middleware write guard", () => {
  const request = (method: string, path: string, headers: Record<string, string>) =>
    new NextRequest(`http://localhost:4392${path}`, {
      method,
      headers: { host: "localhost:4392", ...headers },
    });

  test("refuses a cross-site POST to any API route", async () => {
    const response = middleware(
      request("POST", "/api/actions/ping", { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).ok).toBe(false);
  });

  test("lets same-origin writes and cross-site reads through", () => {
    const write = middleware(
      request("POST", "/api/councils", {
        origin: "http://localhost:4392",
        "sec-fetch-site": "same-origin",
      }),
    );
    expect(write.status).toBe(200);
    expect(write.headers.get("x-middleware-next")).toBe("1");
    const read = middleware(request("GET", "/api/agents", { origin: "https://evil.example" }));
    expect(read.headers.get("x-middleware-next")).toBe("1");
  });
});
