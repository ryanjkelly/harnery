#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Playwright keeps process-wide browser transport state. Running these files
// after the large unit/integration graph in the same Bun process eventually
// stalls Chromium startup, even when launches are serialized. Keep the
// stateful browser partition in a fresh process without dropping any tests.
const browserFiles = new Set([
  "src/lib/browser/netscape-cookies.test.ts",
  "src/lib/browser/session-browser.test.ts",
  "src/lib/browser/session-control.test.ts",
  "tests/e2e/browse-asserts.test.ts",
  "tests/e2e/browse-content-checks.test.ts",
  "tests/e2e/browse-critique.test.ts",
  "tests/e2e/browse-layout-lint.test.ts",
  "tests/e2e/browse-session.test.ts",
]);

// These files either own a long-lived fixture process or repeatedly resize and
// evaluate a live page. Browser state left by earlier files can stall later
// Playwright operations even when Bun runs tests serially. Give them fresh Bun
// processes so each suite starts with clean browser transport state.
const browserProcessFiles = new Set([
  "src/lib/browser/session-browser.test.ts",
  "tests/e2e/browse-layout-lint.test.ts",
  "tests/e2e/browse-session.test.ts",
]);

// Browser-backed checks can spend several seconds waiting for Chromium on a
// shared CI runner. Keep the core suite's strict default while giving this
// isolated partition enough room to finish real browser work.
const browserTestArgs = ["--max-concurrency", "1", "--timeout", "15000"];

function discoverTests(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return discoverTests(path);
    if (!entry.isFile() || !entry.name.endsWith(".test.ts")) return [];
    return [relative(repoRoot, path).split(sep).join("/")];
  });
}

function run(label, files, extraArgs = []) {
  process.stdout.write(`\n=== ${label} (${files.length} files) ===\n`);
  const result = spawnSync(process.execPath, ["test", ...files, ...extraArgs], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const allFiles = [
  ...discoverTests(join(repoRoot, "src")),
  ...discoverTests(join(repoRoot, "tests")),
].sort();
const coreFiles = allFiles.filter((file) => !browserFiles.has(file));
const isolatedBrowserFiles = allFiles.filter(
  (file) => browserFiles.has(file) && !browserProcessFiles.has(file),
);
const isolatedBrowserProcessFiles = allFiles.filter((file) => browserProcessFiles.has(file));

if (isolatedBrowserFiles.length + isolatedBrowserProcessFiles.length !== browserFiles.size) {
  const found = new Set([...isolatedBrowserFiles, ...isolatedBrowserProcessFiles]);
  const missing = [...browserFiles].filter((file) => !found.has(file));
  throw new Error(`browser test partition is stale; missing: ${missing.join(", ")}`);
}

for (const file of isolatedBrowserProcessFiles) {
  run(`browser process partition: ${file}`, [file], browserTestArgs);
}
run("browser test partition", isolatedBrowserFiles, browserTestArgs);
run("core test partition", coreFiles);
