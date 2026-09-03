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
  "src/lib/browser/client-capture.test.ts",
  "src/lib/browser/netscape-cookies.test.ts",
  "src/lib/browser/session-browser.test.ts",
  "src/lib/browser/session-control.test.ts",
  "tests/e2e/browse-asserts.test.ts",
  "tests/e2e/browse-content-checks.test.ts",
  "tests/e2e/browse-critique.test.ts",
  "tests/e2e/browse-layout-lint.test.ts",
  "tests/e2e/browse-qa-plan.test.ts",
  "tests/e2e/browse-session.test.ts",
  "tests/e2e/browse-tiling-lab.test.ts",
]);

// These files either own a long-lived fixture process or repeatedly resize and
// evaluate a live page. Browser state left by earlier files can stall later
// Playwright operations even when Bun runs tests serially. Give them fresh Bun
// processes so each suite starts with clean browser transport state.
const browserProcessFiles = new Set([
  "src/lib/browser/client-capture.test.ts",
  "src/lib/browser/session-browser.test.ts",
  "tests/e2e/browse-layout-lint.test.ts",
  "tests/e2e/browse-session.test.ts",
]);

// Browser-backed checks can spend several seconds waiting for Chromium on a
// shared CI runner. Keep the core suite's strict default while giving this
// isolated partition enough room to finish real browser work.
const browserTestArgs = ["--max-concurrency", "1", "--timeout", "15000"];
const partitionTimings = [];

// These suites repeatedly start workflow subprocesses. Give each lifecycle its
// own process so a timed-out operation cannot leak into the other suite's
// cleanup. Retain the ordinary timeout and every test.
const workflowProcessFiles = new Set([
  "src/core/governor/index.test.ts",
  "src/core/workflow/engine.test.ts",
]);

// The complete suite has several intentionally process-heavy families. Keep
// them separate from ordinary unit tests so the timing summary identifies the
// source of a slowdown instead of reporting one opaque core bucket.
const namedCorePartitions = [
  {
    label: "CLI integration test partition",
    matches: (file) => file.startsWith("tests/integration/"),
  },
  {
    label: "workflow and governor test partition",
    matches: (file) =>
      file.startsWith("src/core/workflow/") ||
      file.startsWith("src/core/work/") ||
      file.startsWith("src/core/governor/"),
  },
  {
    label: "event recorder test partition",
    matches: (file) => file.startsWith("src/core/events/v3/producers/"),
  },
];

function formatDuration(durationMs) {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(2)}s`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

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
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, ["test", ...files, ...extraArgs], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  const durationMs = performance.now() - startedAt;
  const outcome = result.status === 0 ? "passed" : "failed";
  partitionTimings.push({ label, files: files.length, durationMs });
  process.stdout.write(
    `=== ${label} ${outcome} in ${formatDuration(durationMs)} (${files.length} files) ===\n`,
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const allFiles = [
  ...discoverTests(join(repoRoot, "src")),
  ...discoverTests(join(repoRoot, "tests")),
].sort();
const nonBrowserFiles = allFiles.filter((file) => !browserFiles.has(file));
const namedCoreFiles = namedCorePartitions
  .map((partition) => ({
    ...partition,
    files: nonBrowserFiles.filter((file) => partition.matches(file) && !workflowProcessFiles.has(file)),
  }))
  .filter((partition) => partition.files.length > 0);
const coreFiles = nonBrowserFiles.filter(
  (file) => !namedCorePartitions.some((partition) => partition.matches(file)),
);
const isolatedBrowserFiles = allFiles.filter(
  (file) => browserFiles.has(file) && !browserProcessFiles.has(file),
);
const isolatedBrowserProcessFiles = allFiles.filter((file) => browserProcessFiles.has(file));

if (isolatedBrowserFiles.length + isolatedBrowserProcessFiles.length !== browserFiles.size) {
  const found = new Set([...isolatedBrowserFiles, ...isolatedBrowserProcessFiles]);
  const missing = [...browserFiles].filter((file) => !found.has(file));
  throw new Error(`browser test partition is stale; missing: ${missing.join(", ")}`);
}

const partitionPlan = [
  ...isolatedBrowserProcessFiles.map((file) => ({
    label: `browser process partition: ${file}`,
    files: [file],
    extraArgs: browserTestArgs,
  })),
  { label: "browser test partition", files: isolatedBrowserFiles, extraArgs: browserTestArgs },
  ...allFiles.filter((file) => workflowProcessFiles.has(file)).map((file) => ({
    label: `workflow process partition: ${file}`,
    files: [file],
    extraArgs: [],
  })),
  ...namedCoreFiles.map((partition) => ({ ...partition, extraArgs: [] })),
  { label: "core test partition", files: coreFiles, extraArgs: [] },
];

if (process.argv.includes("--list")) {
  for (const partition of partitionPlan) {
    process.stdout.write(`${partition.label}: ${partition.files.length} files\n`);
  }
  process.exit(0);
}

for (const partition of partitionPlan) {
  run(partition.label, partition.files, partition.extraArgs);
}

process.stdout.write("\n=== Test partition timings (slowest first) ===\n");
for (const timing of partitionTimings.toSorted((a, b) => b.durationMs - a.durationMs)) {
  process.stdout.write(
    `- ${timing.label}: ${formatDuration(timing.durationMs)} (${timing.files} files)\n`,
  );
}
