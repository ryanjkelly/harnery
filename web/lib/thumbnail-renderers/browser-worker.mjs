let browser;
let browserServer;
let opening;
let sequence = 0;
const assets = new Map();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await opening?.catch(() => undefined);
  await browserServer?.close();
  process.exit(0);
}
process.on("disconnect", close);
process.on("SIGTERM", close);
process.on("SIGINT", close);

async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (!opening) {
    const current = import("playwright")
      .then(async ({ chromium }) => {
        await browserServer?.close();
        const server = await chromium.launchServer({
          headless: true,
          chromiumSandbox: true,
          host: "127.0.0.1",
          timeout: 10000,
        });
        browserServer = server;
        process.send?.({ type: "browser-process", pid: server.process().pid });
        const instance = await chromium.connect(server.wsEndpoint(), { timeout: 10000 });
        browser = instance;
        instance.once("disconnected", () => {
          if (browser === instance) browser = undefined;
        });
        return instance;
      })
      .finally(() => {
        if (opening === current) opening = undefined;
      });
    opening = current;
  }
  return opening;
}

async function render(message) {
  const instance = await getBrowser();
  const context = await instance.newContext({
    viewport: { width: 720, height: 480 },
    javaScriptEnabled: false,
    serviceWorkers: "block",
    acceptDownloads: false,
    reducedMotion: "reduce",
  });
  const origin = new URL(message.url).origin;
  let mainServed = false;
  const allowed = new Set(message.allowedPaths);
  const assetIds = new Set();
  try {
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin || request.method() !== "GET") return route.abort();
      if (!mainServed && request.url() === message.url && request.resourceType() === "document") {
        mainServed = true;
        return route.fulfill({
          body: Buffer.from(message.html),
          contentType: "text/html; charset=utf-8",
          headers: {
            "content-security-policy": `default-src 'none'; script-src 'none'; style-src 'unsafe-inline' ${origin}; img-src data: ${origin}; font-src data: ${origin}; frame-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; sandbox`,
          },
        });
      }
      if (
        !["image", "stylesheet", "font"].includes(request.resourceType()) ||
        !allowed.has(url.pathname)
      )
        return route.abort();
      const assetId = ++sequence;
      assetIds.add(assetId);
      const result = await new Promise((resolve) => {
        assets.set(assetId, resolve);
        process.send?.({ type: "asset", id: message.id, assetId, pathname: url.pathname });
      });
      if (!result.bytes) return route.abort();
      return route.fulfill({
        body: Buffer.from(result.bytes),
        contentType: result.mime,
        headers: { "access-control-allow-origin": "*", "x-content-type-options": "nosniff" },
      });
    });
    const page = await context.newPage();
    await page.goto(message.url, { waitUntil: "load", timeout: 8000 });
    return await page.screenshot({ type: "png", timeout: 5000, animations: "disabled" });
  } finally {
    for (const id of assetIds) {
      const resolve = assets.get(id);
      assets.delete(id);
      resolve?.({});
    }
    await context.close();
  }
}

process.on("message", async (message) => {
  if (message.type === "asset-result") {
    const resolve = assets.get(message.assetId);
    assets.delete(message.assetId);
    resolve?.(message);
    return;
  }
  if (message.type === "close") {
    await close();
    return;
  }
  if (message.type !== "render") return;
  try {
    const bytes = await render(message);
    process.send?.({ type: "result", id: message.id, bytes });
  } catch {
    process.send?.({ type: "result", id: message.id, error: "thumbnail_browser_failed" });
  }
});
