import { createServer } from "node:http";
import { Browser } from "../../../src/lib/browser/client.ts";
import { startBrowserSessionServer } from "../../../src/lib/browser/session-control.ts";

const controlFile = process.argv[2];
const profileDir = process.argv[3];
if (!controlFile || !profileDir) throw new Error("usage: host.ts <control-file> <profile-dir>");

const fixture = createServer((request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("set-cookie", "fixture_session=shared; Path=/");
  response.end(`<!doctype html>
    <html>
      <head><title>Live session fixture</title></head>
      <body>
        <h1>Live session fixture</h1>
        <label>Message <input name="message"></label>
        <button onclick="document.querySelector('#result').textContent = document.querySelector('input').value">Apply</button>
        <p id="result">Waiting</p>
        <p id="path">${request.url}</p>
      </body>
    </html>`);
});

await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
if (!address || typeof address === "string") throw new Error("fixture did not bind");
const origin = `http://127.0.0.1:${address.port}`;
const browser = new Browser({ profileDir, navigationTimeout: 10_000 });
let session: Awaited<ReturnType<typeof startBrowserSessionServer>> | null = null;
let resolveSignal!: () => void;
const signal = new Promise<void>((resolve) => {
  resolveSignal = resolve;
});
const onSignal = () => resolveSignal();

try {
  await browser.open();
  await browser.navigate(`${origin}/first`);
  session = await startBrowserSessionServer(controlFile, browser);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.stdout.write(`${JSON.stringify({ ready: true, origin })}\n`);
  await Promise.race([session.closeRequested, signal]);
  await session.stopAccepting();
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await session?.cleanup();
  await browser.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
}
