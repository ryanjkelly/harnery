import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "../cookies/index.ts";
import { PaceGate, pacePolicyFromEnv } from "../pace/index.ts";
import { Browser } from "./client.ts";

test("a cookie guard stops the session when a response swaps a cookie, and nothing is saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harnery-cookie-guard-"));
  const arrivals: string[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, "http://fixture").pathname;
    arrivals.push(path);
    if (path === "/swap") {
      res.setHeader("set-cookie", "identity=changed; Path=/");
      res.end("swapped");
      return;
    }
    if (path === "/after") {
      res.end("after");
      return;
    }
    res.setHeader("set-cookie", "identity=original; Path=/");
    res.setHeader("content-type", "text/html");
    res.end("<p>start</p><script>setTimeout(() => fetch('/swap'), 50)</script>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const base = `http://127.0.0.1:${address.port}`;
  const jar = new CookieJar({ path: join(dir, "cookies.json") });
  const phases: string[] = [];
  const browser = new Browser({
    profileDir: join(dir, "profile"),
    jar,
    pace: new PaceGate({
      ...pacePolicyFromEnv({}),
      enabled: false,
      ledgerPath: join(dir, "pace.json"),
    }),
    cookieGuard: (cookies, event) => {
      phases.push(event.phase);
      if (cookies.some((c) => c.name === "identity" && c.value === "changed")) {
        throw new Error("identity changed");
      }
    },
  });
  try {
    await browser.open();
    await browser.navigate(`${base}/start`);
    for (let i = 0; i < 100 && !browser.cookieGuardFault; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(String(browser.cookieGuardFault)).toContain("identity changed");
    await expect(browser.navigate(`${base}/after`)).rejects.toBeDefined();
    expect(arrivals).not.toContain("/after");
    await browser.close();
    expect(jar.list().some((c) => c.name === "identity")).toBe(false);
    expect(phases).toContain("request");
    expect(phases).toContain("response");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);

test("a cookie guard that never throws leaves the session and the jar alone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harnery-cookie-guard-ok-"));
  const server = createServer((_req, res) => {
    res.setHeader("set-cookie", "identity=original; Path=/");
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const jar = new CookieJar({ path: join(dir, "cookies.json") });
  const phases: string[] = [];
  const browser = new Browser({
    profileDir: join(dir, "profile"),
    jar,
    pace: new PaceGate({
      ...pacePolicyFromEnv({}),
      enabled: false,
      ledgerPath: join(dir, "pace.json"),
    }),
    cookieGuard: (_cookies, event) => void phases.push(event.phase),
  });
  try {
    await browser.open();
    await browser.navigate(`http://127.0.0.1:${address.port}/`);
    await browser.close();
    expect(browser.cookieGuardFault).toBeUndefined();
    expect(phases).toContain("close");
    expect(jar.list().some((c) => c.name === "identity" && c.value === "original")).toBe(true);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
