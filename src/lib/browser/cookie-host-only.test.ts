import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CookieJar } from "../cookies/index.ts";
import { PaceGate, pacePolicyFromEnv } from "../pace/index.ts";
import { Browser } from "./client.ts";

test("a host-only jar cookie reaches its exact host in Chromium and no subdomain or sibling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "harnery-host-only-browser-"));
  const seen = new Map<string, string | undefined>();
  const server = createServer((req, res) => {
    seen.set(String(req.headers.host).replace(/:\d+$/, ""), req.headers.cookie);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const jar = new CookieJar({ path: join(dir, "cookies.json") });
  jar.merge([
    {
      name: "__Host-session",
      value: "secret",
      domain: "app.localhost",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    // Breaks its prefix (domain cookie): left out instead of aborting the session.
    {
      name: "__Host-broken",
      value: "x",
      domain: ".localhost",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const browser = new Browser({
    profileDir: join(dir, "profile"),
    jar,
    pace: new PaceGate({
      ...pacePolicyFromEnv({}),
      enabled: false,
      ledgerPath: join(dir, "pace.json"),
    }),
  });
  try {
    await browser.open();
    for (const host of ["app.localhost", "evil.app.localhost", "share.localhost"]) {
      await browser.navigate(`http://${host}:${address.port}/`);
    }
    expect(seen.get("app.localhost")).toBe("__Host-session=secret");
    expect(seen.get("evil.app.localhost")).toBeUndefined();
    expect(seen.get("share.localhost")).toBeUndefined();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
