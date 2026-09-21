import { describe, expect, test } from "bun:test";
import { applyUpstreamHeaders } from "./forward-headers.ts";

describe("applyUpstreamHeaders", () => {
  test("rewrites Host and copies the original Host to X-Forwarded-Host", () => {
    const headers = new Headers({
      host: "words-here.trycloudflare.com",
      origin: "https://words-here.trycloudflare.com",
    });
    applyUpstreamHeaders(headers, "app.localhost");
    expect(headers.get("host")).toBe("app.localhost");
    expect(headers.get("x-forwarded-host")).toBe("words-here.trycloudflare.com");
    expect(headers.get("origin")).toBe("https://words-here.trycloudflare.com");
    expect(headers.get("accept-encoding")).toBe("identity");
  });

  test("overwrites a client-supplied X-Forwarded-Host", () => {
    const headers = new Headers({
      host: "words-here.trycloudflare.com",
      "x-forwarded-host": "evil.example",
    });
    applyUpstreamHeaders(headers, "app.localhost");
    expect(headers.get("x-forwarded-host")).toBe("words-here.trycloudflare.com");
  });
});
