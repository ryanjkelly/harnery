/**
 * Example: tail a peer agent's journal as they write to it.
 *
 * The journal lib exposes a simple file API. Pick up any peer's
 * instance_id (e.g. via the coord-reader), and watch their journal
 * file for changes. Useful for human-in-the-loop sessions where you
 * want to follow a long-running agent's reasoning out of band.
 *
 * Run:
 *   bun run examples/journal-tail.ts <instance-id-or-name>
 */

import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { monorepoRoot } from "../src/core/agents/index.ts";
import { loadJournal, resolveOwnerByName, journalDir } from "../src/core/journal/index.ts";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: journal-tail.ts <instance-id-or-name>");
  process.exit(1);
}

const root = monorepoRoot();
if (!root) {
  console.error("No .harnery/ found.");
  process.exit(1);
}

// Accept either a name (e.g. "Maya") or a full instance_id.
const instanceId = arg.includes("-") ? arg : resolveOwnerByName(arg);
if (!instanceId) {
  console.error(`No agent named "${arg}" in the active registry.`);
  process.exit(1);
}

const path = join(journalDir(), `${instanceId}.md`);
if (!existsSync(path)) {
  console.log(`(no journal yet at ${path}; waiting for first write…)`);
}

let lastSize = 0;
const printLatest = (): void => {
  const doc = loadJournal(instanceId);
  if (!doc || doc.entries.length === 0) return;
  if (doc.bytes === lastSize) return;
  lastSize = doc.bytes;
  const e = doc.entries[0]; // most-recent
  console.log(`\n── ${e.ts_display} · ${e.category} ──`);
  console.log(e.body);
};

printLatest();

watch(journalDir(), (_evt, fname) => {
  if (fname === `${instanceId}.md`) printLatest();
});

console.log(`\n[watching ${path}, Ctrl-C to exit]`);
