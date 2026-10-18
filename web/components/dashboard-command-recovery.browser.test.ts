import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { GET as status } from "@/app/api/actions/commands/[commandId]/route";
import { POST as ping } from "@/app/api/actions/ping/route";
import { __resetCoordRootCache } from "@/lib/coord-reader";
import * as writer from "@/lib/coord-writer";

afterEach(() => {
  mock.restore();
});

test("the rendered ping form recovers its lost response after reload without another delivery", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dashboard-reconnect-"));
  const previous = process.env.HARNERY_COORD_ROOT;
  mkdirSync(path.join(root, ".harnery"));
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
  const deliver = spyOn(writer, "pingAgent").mockReturnValue({
    ok: true,
    target_instance: "fixture-owner",
    bytes: 12,
  });
  const webRoot = path.resolve(import.meta.dir, "..");
  const entry = path.join(root, "entry.ts");
  writeFileSync(
    entry,
    `import React from ${JSON.stringify(fileURLToPath(import.meta.resolve("react")))};
    import { createRoot } from ${JSON.stringify(fileURLToPath(import.meta.resolve("react-dom/client")))};
    import { PingForm } from ${JSON.stringify(path.join(webRoot, "components/PingForm.tsx"))};
    import { HostInfoProvider } from ${JSON.stringify(path.join(webRoot, "components/HostInfoProvider.tsx"))};
    createRoot(document.getElementById("app")).render(React.createElement(HostInfoProvider,
      { value: { binName: "harn", repoRoot: ${JSON.stringify(root)} } }, React.createElement(PingForm, { instanceId: "fixture-owner" })));`,
  );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let page: Awaited<ReturnType<NonNullable<typeof browser>["newPage"]>> | undefined;
  let posts = 0,
    reads = 0;
  try {
    const bundle = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      plugins: [
        {
          name: "web-alias",
          setup(build) {
            build.onResolve({ filter: /^@\// }, ({ path: name }) => ({
              path: Bun.resolveSync(path.join(webRoot, name.slice(2)), webRoot),
            }));
          },
        },
      ],
    });
    expect(bundle.success).toBe(true);
    if (!bundle.success) throw new Error(bundle.logs.join("\n"));
    const js = await bundle.outputs[0]!.text();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== "https://dashboard-fixture.invalid") return route.abort();
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: '<meta charset="utf-8"><div id="app"></div><script src="/client.js"></script>',
        });
      if (url.pathname === "/client.js")
        return route.fulfill({ contentType: "text/javascript; charset=utf-8", body: js });
      if (url.pathname === "/api/actions/ping" && request.method() === "POST") {
        posts++;
        const response = await ping(
          new Request(request.url(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: request.postData(),
          }),
        );
        expect(response.status).toBe(200);
        return route.abort("failed"); // The durable action settled, but the browser never received it.
      }
      if (url.pathname.startsWith("/api/actions/commands/") && request.method() === "GET") {
        reads++;
        const response = await status(new Request(request.url()), {
          params: Promise.resolve({ commandId: url.pathname.split("/").at(-1)! }),
        });
        return route.fulfill({
          status: response.status,
          contentType: "application/json",
          body: await response.text(),
        });
      }
      return route.abort();
    });
    await page.goto("https://dashboard-fixture.invalid/");
    await page.locator("textarea").fill("one delivery");
    await page.getByRole("button", { name: "ping", exact: true }).click();
    await page.waitForFunction(() => document.body.textContent?.includes("Failed to fetch"));
    const retainedBefore = await page.evaluate(() =>
      Object.values(localStorage).map((text) => JSON.parse(text)),
    );
    expect(retainedBefore).toHaveLength(1);
    expect(retainedBefore[0].intent.arguments).toEqual({
      instance_id: "fixture-owner",
      message: "one delivery",
    });
    await page.reload();
    await page
      .getByText("Recovered ping: pinged · 12 bytes", { exact: true })
      .waitFor({ timeout: 5000 });
    const retainedAfter = await page.evaluate(() =>
      Object.values(localStorage).map((text) => JSON.parse(text)),
    );
    expect(retainedAfter[0].intent).toEqual(retainedBefore[0].intent);
    expect(retainedAfter[0].receipt.state).toBe("settled");
    expect(posts).toBe(1);
    expect(reads).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
    const proofDir = process.env.HARNERY_DASHBOARD_PROOF_DIR;
    if (proofDir) {
      mkdirSync(proofDir, { recursive: true });
      await page.screenshot({ path: path.join(proofDir, "reconnected.png") });
      writeFileSync(
        path.join(proofDir, "rendered-reconnect.json"),
        JSON.stringify(
          {
            fixture_origin: "https://dashboard-fixture.invalid",
            network: "all requests intercepted; no listening server or external traffic",
            rendered_component: "PingForm with HostInfoProvider",
            original_intent: retainedBefore[0].intent,
            recovered_receipt: retainedAfter[0].receipt,
            posts,
            status_reads: reads,
            helper_calls: deliver.mock.calls.length,
            marker: "Recovered ping: pinged · 12 bytes",
            page_errors: failures,
          },
          null,
          2,
        ),
      );
    }
  } catch (error) {
    const proofDir = process.env.HARNERY_DASHBOARD_PROOF_DIR;
    if (proofDir && page) {
      mkdirSync(proofDir, { recursive: true });
      writeFileSync(
        path.join(proofDir, "rendered-failure.json"),
        JSON.stringify(
          {
            error: String(error),
            posts,
            reads,
            body: await page.locator("body").innerText(),
            storage: await page.evaluate(() => ({ ...localStorage })),
          },
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    await browser?.close();
    if (previous === undefined) delete process.env.HARNERY_COORD_ROOT;
    else process.env.HARNERY_COORD_ROOT = previous;
    __resetCoordRootCache();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
