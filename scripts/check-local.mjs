#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const groups = {
  core: [
    ["Lint", root, "bun", ["run", "lint"]],
    ["Typecheck", root, "bun", ["run", "typecheck"]],
    ["Core tests", root, "bun", ["run", "test"]],
  ],
  integration: [["Integration tests", root, "bun", ["run", "test:integration"]]],
  smoke: [["Packed Node package", root, "node", ["scripts/smoke-test.mjs"]]],
  web: [
    ["Dashboard dependencies", join(root, "web"), "bun", ["install", "--frozen-lockfile"]],
    ["Dashboard tests", join(root, "web"), "bun", ["test"]],
    ["Dashboard build", join(root, "web"), "bun", ["run", "build"]],
  ],
};

const args = process.argv.slice(2);
const list = args.includes("--list");
const selections = args.filter((arg) => arg !== "--list");
const selected =
  selections.length === 0 || selections[0] === "all" ? Object.keys(groups) : selections;
if (
  (selections.includes("all") && selections.length !== 1) ||
  selected.some((group) => !Object.hasOwn(groups, group))
) {
  console.error("Usage: bun run check:local [all | core integration smoke web] [--list]");
  process.exit(2);
}

for (const group of new Set(selected)) {
  for (const [label, cwd, command, argv] of groups[group]) {
    console.log(`local check: ${label} (${command} ${argv.join(" ")})`);
    if (list) continue;
    const result = spawnSync(command, argv, { cwd, stdio: "inherit" });
    if (result.error || result.status !== 0) {
      console.error(
        `local check: ${label} failed${result.error ? `: ${result.error.message}` : ""}`,
      );
      process.exit(result.status ?? 1);
    }
  }
}
if (!list) console.log("local check: all selected checks passed; nothing was published.");
