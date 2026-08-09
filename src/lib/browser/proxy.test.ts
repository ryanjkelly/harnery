import { describe, expect, test } from "bun:test";
import { browserProxyFromEnv, browserProxyGateFromEnv, extractObservedIp } from "./proxy.js";

describe("browser proxy environment", () => {
  test("separates encoded credentials from the Playwright proxy server", () => {
    expect(
      browserProxyFromEnv({
        HTTPS_PROXY: "http://acme_isp:Secret%2B123%3D@isp.example:10001",
      }),
    ).toEqual({
      server: "http://isp.example:10001",
      username: "acme_isp",
      password: "Secret+123=",
    });
  });

  test("fails closed on missing, partial, or malformed proxy configuration", () => {
    expect(() => browserProxyFromEnv({})).toThrow("requires HTTPS_PROXY");
    expect(() => browserProxyFromEnv({ HTTPS_PROXY: "socks5://host:1080" })).toThrow(
      "http:// or https://",
    );
    expect(() =>
      browserProxyGateFromEnv({ HARNERY_BROWSER_PROXY_EXPECTED_IP: "192.0.2.10" }),
    ).toThrow("must be set together");
  });

  test("reads a complete fixed-egress gate", () => {
    expect(
      browserProxyGateFromEnv({
        HARNERY_BROWSER_PROXY_EXPECTED_IP: "192.0.2.10",
        HARNERY_BROWSER_PROXY_CHECK_URL: "https://ip.example.test/json",
      }),
    ).toEqual({
      expectedIp: "192.0.2.10",
      checkUrl: "https://ip.example.test/json",
    });
  });

  test("extracts common JSON and plain-text IP response shapes", () => {
    expect(extractObservedIp('{"ip":"192.0.2.10"}')).toBe("192.0.2.10");
    expect(extractObservedIp('{"origin":"192.0.2.10, 198.51.100.20"}')).toBe("192.0.2.10");
    expect(extractObservedIp('{"proxy":{"ip":"192.0.2.10"}}')).toBe("192.0.2.10");
    expect(extractObservedIp("192.0.2.10\n")).toBe("192.0.2.10");
    expect(extractObservedIp("not an address")).toBeNull();
  });
});
