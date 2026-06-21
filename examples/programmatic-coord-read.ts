/**
 * Example: programmatic read of the coord layer.
 *
 * Useful when building a custom dashboard, a periodic job that audits
 * stale agents, or a smoke-test that asserts coord state in CI.
 *
 * `monorepoRoot()` walks up looking for `.harnery/` the same way the bash
 * hooks do. From there, .harnery/active/<id>.json is one heartbeat per
 * active agent. Just plain JSON files, no DB, no daemon.
 *
 * Run:
 *   bun run examples/programmatic-coord-read.ts
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { monorepoRoot } from "../src/core/agents/index.ts";

interface Heartbeat {
  instance_id: string;
  name: string;
  platform?: string;
  last_heartbeat: string;
  files_touched: string[];
  task?: string;
  model?: string;
}

const root = monorepoRoot();
if (!root) {
  console.error(
    "No .harnery/ found. Run this from inside a monorepo with a coord layer.",
  );
  process.exit(1);
}

const activeDir = join(root, ".harnery", "active");
if (!existsSync(activeDir)) {
  console.error(`No heartbeats yet at ${activeDir}.`);
  process.exit(0);
}

const heartbeats: Heartbeat[] = [];
for (const f of readdirSync(activeDir)) {
  if (!f.endsWith(".json")) continue;
  try {
    heartbeats.push(JSON.parse(readFileSync(join(activeDir, f), "utf-8")) as Heartbeat);
  } catch {
    // skip malformed
  }
}

console.log(`coord root: ${root}`);
console.log(`active heartbeats: ${heartbeats.length}`);

const now = Date.now();
for (const hb of heartbeats) {
  const ageS = Math.floor((now - Date.parse(hb.last_heartbeat)) / 1000);
  console.log(
    `  ${hb.name.padEnd(15)} ${(hb.platform ?? "?").padEnd(12)} ${
      hb.files_touched.length
    } files  ${ageS}s ago`,
  );
}

// Audit example: flag agents claiming more than 50 files (potential runaway).
const heavy = heartbeats.filter((h) => h.files_touched.length > 50);
if (heavy.length > 0) {
  console.warn(
    `\n⚠ ${heavy.length} agent(s) holding > 50 file claims:`,
    heavy.map((h) => `${h.name} (${h.files_touched.length})`).join(", "),
  );
}
