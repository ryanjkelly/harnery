import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium } from "playwright";
import { __resetCoordRootCache } from "@/lib/coord-reader";

async function withFixture(run: (context: BrowserContext) => Promise<void>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "attention-tabs-"));
  const previous = process.env.HARNERY_COORD_ROOT;
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
  mkdirSync(path.join(root, ".harnery"));
  const webRoot = path.resolve(import.meta.dir, "..");
  const entry = path.join(root, "entry.ts");
  writeFileSync(
    entry,
    `
    import React from ${JSON.stringify(fileURLToPath(import.meta.resolve("react")))};
    import { createRoot } from ${JSON.stringify(fileURLToPath(import.meta.resolve("react-dom/client")))};
    import { AttentionProvider, useAttentionSlot, useAttentionState } from ${JSON.stringify(path.join(webRoot, "components/AttentionProvider.tsx"))};
    import { Attention } from ${JSON.stringify(path.join(webRoot, "components/Attention.tsx"))};
    const titleProperty = Object.getOwnPropertyDescriptor(Document.prototype, "title");
    window.attentionTitleStarts = [];
    Object.defineProperty(document, "title", { configurable: true,
      get: () => titleProperty.get.call(document),
      set: (value) => {
        if (value.includes("Copy prompt") || value.includes("New event")) window.attentionTitleStarts.push(value);
        titleProperty.set.call(document, value);
      },
    });
    const hold = location.search.includes("hold");
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (url, init) => {
      const response = await nativeFetch(url, init);
      if (!hold || JSON.parse(init.body).operation !== "claim") return response;
      const data = await response.json();
      return new Promise((resolve) => {
        window.claimReady = true;
        window.releaseClaim = () => resolve({ ok: true, json: () => {
          let turns = 0; const settle = () => { if (++turns < 8) queueMicrotask(settle); else window.claimProcessed = true; };
          queueMicrotask(settle); return Promise.resolve(data);
        } });
      });
    };
    let releaseGate; const blocked = new Promise((resolve) => { releaseGate = resolve; });
    function State() {
      const state = useAttentionState(), set = useAttentionSlot();
      window.replaceSlot = () => React.startTransition(() => set({ key: "att:new", label: "New event", channels: { audio: false, favicon: false, flow: false } }));
      window.unblock = () => { window.allowNew = true; releaseGate(); };
      if (hold && state.request?.key === "att:new" && !window.allowNew) throw blocked;
      return React.createElement("div", { "data-alerting": String(state.isAlerting), "data-event": state.request?.key }, "Action remains available");
    }
    createRoot(document.getElementById("app")).render(React.createElement(React.Suspense, { fallback: "Pending transition" }, React.createElement(AttentionProvider, null,
      React.createElement(Attention, { request: { key: "att:fixture:copy", label: "Copy prompt", channels: { audio: false, favicon: false, flow: false } } }),
      React.createElement(State))));
  `,
  );
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
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
    browser = await chromium.launch({ headless: true, timeout: 10000 });
    const context = await browser.newContext();
    const errors: string[] = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== "https://attention-fixture.invalid") return route.abort();
      if (url.pathname === "/")
        return route.fulfill({
          contentType: "text/html",
          body: '<meta charset="utf-8"><title>Dashboard</title><div id="app"></div><script src="/client.js"></script>',
        });
      if (url.pathname === "/client.js")
        return route.fulfill({ contentType: "text/javascript", body: js });
      if (url.pathname === "/api/attention") {
        if (request.postDataJSON()?.eventKey === "att:new") {
          const now = Date.now();
          return route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              eventKey: "att:new",
              recipientId: null,
              generation: null,
              state: "waiting",
              granted: false,
              engaged: false,
              serverNow: now,
              expiresAt: now,
            }),
          });
        }
        // The baseline never reaches this route. Resolve it only once implemented.
        const modulePath = path.join(webRoot, "app/api/attention/route.ts");
        const { POST } = await import(modulePath);
        const response = await POST(
          new Request(request.url(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: request.postData(),
          }),
        );
        return route.fulfill({
          status: response.status,
          contentType: "application/json",
          body: await response.text(),
        });
      }
      return route.abort();
    });
    await run(context);
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    if (previous === undefined) delete process.env.HARNERY_COORD_ROOT;
    else process.env.HARNERY_COORD_ROOT = previous;
    __resetCoordRootCache();
    rmSync(root, { recursive: true, force: true });
  }
}

test("two rendered tabs keep the inline event but start one automatic title alert", async () => {
  await withFixture(async (context) => {
    const first = await context.newPage();
    await first.goto("https://attention-fixture.invalid/");
    await first.locator('[data-alerting="true"]').waitFor({ timeout: 5000 });
    await first.waitForFunction(
      () =>
        (window as unknown as { attentionTitleStarts: string[] }).attentionTitleStarts.length > 0,
      undefined,
      {
        timeout: 5000,
      },
    );
    const second = await context.newPage();
    await second.goto("https://attention-fixture.invalid/");
    await second.locator('[data-alerting="true"]').waitFor();
    const starts = await Promise.all(
      [first, second].map((page) =>
        page.evaluate(
          () => (window as unknown as { attentionTitleStarts: string[] }).attentionTitleStarts,
        ),
      ),
    );
    expect(
      starts.filter((titles) => titles.some((title) => title.includes("Copy prompt"))),
    ).toHaveLength(1);
    expect(await first.locator(".attention-edge").count()).toBe(1);
    expect(await second.locator(".attention-edge").count()).toBe(1);
    expect(await second.locator("body").innerText()).toContain("Action remains available");
  });
}, 30_000);

test("an old claim cannot start channels for a synchronously replaced slot before React commits", async () => {
  await withFixture(async (context) => {
    const page = await context.newPage();
    await page.goto("https://attention-fixture.invalid/?hold");
    await page.waitForFunction(() => (window as unknown as { claimReady: boolean }).claimReady);
    await page.evaluate(() => {
      const fixture = window as unknown as { replaceSlot: () => void; releaseClaim: () => void };
      fixture.replaceSlot();
      fixture.releaseClaim();
    });
    await page.waitForFunction(
      () => (window as unknown as { claimProcessed: boolean }).claimProcessed,
    );
    expect(
      await page.evaluate(
        () => (window as unknown as { attentionTitleStarts: string[] }).attentionTitleStarts,
      ),
    ).toEqual([]);
    await page.evaluate(() => (window as unknown as { unblock: () => void }).unblock());
    await page.locator('[data-event="att:new"]').waitFor();
    expect(
      await page.evaluate(
        () => (window as unknown as { attentionTitleStarts: string[] }).attentionTitleStarts,
      ),
    ).toEqual([]);
  });
}, 30_000);
