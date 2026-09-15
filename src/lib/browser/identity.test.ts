import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "./client.ts";
import { browserIdentity } from "./identity.ts";
import { normalUserAgent } from "./user-agent.ts";

test("desktop identity matches the UA while respecting custom agents", () => {
  expect(browserIdentity(normalUserAgent(150, "windows"), "150.0.1.2")).toMatchObject({
    platform: "Win32",
    userAgentMetadata: {
      platform: "Windows",
      fullVersionList: [
        { brand: "Chromium", version: "150.0.1.2" },
        { brand: "Google Chrome", version: "150.0.1.2" },
      ],
    },
  });
  expect(browserIdentity(normalUserAgent(150, "mac"))?.platform).toBe("MacIntel");
  expect(browserIdentity("Custom/1")).toBeUndefined();
});

test("initial pages, new tabs and popups agree on navigator and HTTP client hints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harnery-identity-"));
  const received: Array<{ path: string; platform: string | undefined }> = [];
  const server = createServer((req, res) => {
    received.push({
      path: req.url!,
      platform: req.headers["sec-ch-ua-platform"] as string | undefined,
    });
    res.setHeader("content-type", "text/html");
    res.setHeader("accept-ch", "Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness");
    res.end('<a href="/popup" target="_blank">Popup</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const url = `http://127.0.0.1:${address.port}`;
  const browser = new Browser({
    profileDir: join(dir, "profile"),
    pace: null,
    userAgent: normalUserAgent(150, "windows"),
  });
  const readIdentity = () =>
    browser.evaluate<unknown>(
      `(async () => ({ platform:navigator.platform, hints:await navigator.userAgentData.getHighEntropyValues(['platform','platformVersion','architecture','bitness']) }))()`,
    );
  try {
    await browser.open();
    await browser.navigate(`${url}/first`);
    expect(await readIdentity()).toMatchObject({
      platform: "Win32",
      hints: { platform: "Windows", platformVersion: "10.0.0", architecture: "x86", bitness: "64" },
    });
    await browser.sessionOpenTab(`${url}/tab`);
    expect(await readIdentity()).toMatchObject({
      platform: "Win32",
      hints: { platform: "Windows" },
    });
    const popup = browser.currentPage.waitForEvent("popup");
    await browser.click("a");
    await (await popup).waitForLoadState();
    expect(await readIdentity()).toMatchObject({
      platform: "Win32",
      hints: { platform: "Windows" },
    });
    expect(received.filter((r) => ["/first", "/tab", "/popup"].includes(r.path))).toEqual([
      { path: "/first", platform: '"Windows"' },
      { path: "/tab", platform: '"Windows"' },
      { path: "/popup", platform: '"Windows"' },
    ]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
