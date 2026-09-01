import { existsSync, writeFileSync } from "node:fs";
import { Browser } from "../../src/lib/browser/client.ts";
import { CookieJar } from "../../src/lib/cookies/client.ts";

const [storePath, profileDir, origin, writer, readyPath, goPath] = process.argv.slice(2);
if (!storePath || !profileDir || !origin || !writer || !readyPath || !goPath) {
  throw new Error("expected store, profile, origin, writer, ready, and go arguments");
}

const jar = new CookieJar({ path: storePath, source: `browser-child-${writer}` });
const browser = new Browser({ jar, profileDir });

try {
  await browser.open();
  await browser.navigate(`${origin}/?writer=${encodeURIComponent(writer)}`);
  writeFileSync(readyPath, `${process.pid}\n`);
  while (!existsSync(goPath)) await new Promise((resolve) => setTimeout(resolve, 5));
} finally {
  await browser.close();
}
