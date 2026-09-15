import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaceGate, pacePolicyFromEnv } from "../pace/index.ts";
import { Browser } from "./client.ts";

test("paces actual documents from clicks, forms, scripts, popups and session verbs once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harnery-navigation-pace-"));
  const reservations: string[] = [];
  const arrivals: string[] = [];
  class FixtureGate extends PaceGate {
    override async before(url: string) {
      // Delaying the gate also verifies that requests wait before reaching the server.
      await new Promise((resolve) => setTimeout(resolve, 20));
      reservations.push(new URL(url).pathname);
      return null;
    }
  }
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    arrivals.push(path);
    if (path === "/redirect") {
      res.writeHead(302, { location: "/redirected" });
      res.end();
      return;
    }
    if (path === "/asset") {
      res.end("asset");
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(`<a href="/next">Next</a><a href="/popup" target="_blank">Popup</a>
      <form action="/submit"><input name="q"><button>Go</button></form>
      <script>fetch('/asset')</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  const gate = new FixtureGate({ ...pacePolicyFromEnv({}), ledgerPath: join(dir, "pace.json") });
  const browser = new Browser({ profileDir: join(dir, "profile"), pace: gate });
  try {
    await browser.open();
    await browser.navigate(`${base}/start`);
    await browser.click("text=Next");
    await browser.currentPage.waitForURL("**/next");
    await browser.sessionClick({ kind: "role", value: "link", name: "Next", partial: false });
    await browser.currentPage.locator("input").focus();
    await browser.sessionPress("Enter");
    await browser.currentPage.waitForURL("**/submit?*");
    await browser.evaluate("location.href='/script'");
    await browser.currentPage.waitForURL("**/script");
    const popup = browser.currentPage.waitForEvent("popup");
    await browser.click("text=Popup");
    await (await popup).waitForLoadState();
    await browser.sessionGoto(`${base}/redirect`);
    await browser.sessionReload();
    await browser.sessionOpenTab(`${base}/tab`);
    await browser.reload();
    expect(reservations).toEqual([
      "/start",
      "/next",
      "/next",
      "/submit",
      "/script",
      "/popup",
      "/redirect",
      "/redirected",
      "/tab",
      "/tab",
    ]);
    expect(arrivals.filter((path) => path !== "/asset" && path !== "/favicon.ico")).toEqual([
      ...reservations.slice(0, 7),
      "/redirected",
      ...reservations.slice(7),
    ]);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
