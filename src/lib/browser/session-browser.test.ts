import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, BrowserSessionActionError } from "./client.ts";

let fixtureServer: Server;
let fixtureOrigin: string;
const browsers: Browser[] = [];

beforeEach(async () => {
  fixtureServer = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
      <html>
        <head><title>Session fixture</title></head>
        <body>
          <h1>Browser session fixture</h1>
          <a href="/next?token=link-query-secret#fragment">Next page</a>
          <button class="duplicate">Duplicate</button>
          <button class="duplicate">Duplicate</button>
          <button id="increment" onclick="document.querySelector('#count').textContent = 'Count 1'">Increment</button>
          <p id="count">Count 0</p>
          <label>Email <input name="email" value="filled-text-secret"></label>
          <label>Password <input name="password" type="password" value="password-secret"></label>
          <input type="hidden" value="hidden-input-secret">
          <script>
            document.cookie = 'fixture_cookie=cookie-secret; path=/';
            localStorage.setItem('fixture_storage', 'storage-secret');
          </script>
        </body>
      </html>`);
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind TCP.");
  fixtureOrigin = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await Promise.all(browsers.splice(0).map((browser) => browser.close()));
  await new Promise<void>((resolve) => fixtureServer.close(() => resolve()));
});

function profile(): string {
  const dir = mkdtempSync(join(tmpdir(), "harnery-session-browser-"));
  chmodSync(dir, 0o700);
  return dir;
}

describe("Browser live session operations", () => {
  test("redacts field values, storage, cookies, headers, and sensitive link parts", async () => {
    const browser = new Browser({
      profileDir: profile(),
      navigationTimeout: 10_000,
      extraHeaders: () => ({ "x-fixture-secret": "header-secret" }),
    });
    browsers.push(browser);
    await browser.open();
    await browser.navigate(fixtureOrigin);
    const inspection = await browser.sessionInspect();
    const serialized = JSON.stringify(inspection);

    expect(inspection.title).toBe("Session fixture");
    expect(inspection.controls.find((control) => control.name === "Email")).toMatchObject({
      has_value: true,
    });
    expect(inspection.controls.find((control) => control.name === "Password")).toMatchObject({
      attributes: { type: "password", name: "password" },
      has_value: true,
    });
    expect(serialized).not.toContain("filled-text-secret");
    expect(serialized).not.toContain("password-secret");
    expect(serialized).not.toContain("hidden-input-secret");
    expect(serialized).not.toContain("cookie-secret");
    expect(serialized).not.toContain("storage-secret");
    expect(serialized).not.toContain("header-secret");
    expect(serialized).not.toContain("link-query-secret");
  });

  test("fails ambiguous locators before clicking and resolves exact accessible locators", async () => {
    const browser = new Browser({ profileDir: profile(), navigationTimeout: 10_000 });
    browsers.push(browser);
    await browser.open();
    await browser.navigate(fixtureOrigin);

    await expect(
      browser.sessionClick({ kind: "text", value: "Duplicate", partial: false }),
    ).rejects.toEqual(
      new BrowserSessionActionError(
        "locator_ambiguous",
        "Locator matched 2 elements; refine it before acting.",
      ),
    );
    expect(await browser.currentPage.locator("#count").textContent()).toBe("Count 0");

    await browser.sessionClick({
      kind: "role",
      value: "button",
      name: "Increment",
      partial: false,
    });
    const scoped = await browser.sessionInspect({
      kind: "selector",
      value: "#count",
      partial: false,
    });
    expect(scoped.text).toBe("Count 1");
    expect(scoped.revision).toBe(1);
  });

  test("writes owner-only screenshots and refuses to overwrite them", async () => {
    const browser = new Browser({ profileDir: profile(), navigationTimeout: 10_000 });
    browsers.push(browser);
    await browser.open();
    await browser.navigate(fixtureOrigin);
    const output = join(profile(), "session.png");

    const screenshot = await browser.sessionScreenshot(output);
    expect(screenshot).toMatchObject({ path: output, revision: 1 });
    expect(screenshot.width).toBeGreaterThan(0);
    expect(screenshot.height).toBeGreaterThan(0);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    await expect(browser.sessionScreenshot(output)).rejects.toMatchObject({
      code: "screenshot_exists",
    });
  });

  test("keeps controlled tabs in the original proxied context", async () => {
    const proxyHits: string[] = [];
    const proxy = createServer((request, response) => {
      proxyHits.push(request.url ?? "");
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("set-cookie", "shared_session=context-cookie; Path=/");
      response.setHeader("connection", "close");
      response.end(`<!doctype html><title>Proxy fixture</title><body>
        <p>Path ${request.url}</p>
        <script>document.body.dataset.cookie = document.cookie;</script>
      </body>`);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Proxy fixture did not bind.");

    try {
      const browser = new Browser({
        profileDir: profile(),
        navigationTimeout: 10_000,
        waitUntil: "domcontentloaded",
        proxy: { server: `http://127.0.0.1:${address.port}` },
        launchArgs: ["--proxy-bypass-list=<-loopback>"],
      });
      browsers.push(browser);
      await browser.open();
      await browser.navigate("http://fixture.invalid/first");
      const opened = await browser.sessionOpenTab("http://fixture.invalid/second");
      expect(opened.index).toBe(1);
      expect((await browser.sessionTabs()).filter((tab) => tab.active)).toHaveLength(1);
      expect(await browser.currentPage.locator("body").getAttribute("data-cookie")).toContain(
        "shared_session=context-cookie",
      );
      expect(proxyHits.some((url) => url.includes("/first"))).toBe(true);
      expect(proxyHits.some((url) => url.includes("/second"))).toBe(true);

      await browser.sessionCloseTab(opened.index);
      expect(await browser.sessionStatus()).toMatchObject({ tab_count: 1, active_tab: 0 });
      await expect(browser.sessionCloseTab(0)).rejects.toMatchObject({ code: "final_tab" });
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
