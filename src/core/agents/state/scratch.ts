/**
 * Scratchpad mutations: append-only timestamped journal at
 * `.harnery/scratch/<instance_id>.md`.
 *
 * Used by the agents-coord web UI route handlers for both operator-nudge
 * appends and inline edits.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const ALLOWED_CATEGORIES = new Set([
  "note",
  "plan",
  "decision",
  "blocker",
  "question",
  "done",
  "handoff",
]);

const APPEND_BODY_CAP = 4096;

function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function scratchPath(coordRoot: string, instanceId: string): string {
  return join(coordRoot, ".harnery", "scratch", `${instanceId}.md`);
}

function archivePath(coordRoot: string, instanceId: string, suffix: string): string {
  return join(coordRoot, ".harnery", "scratch", "archived", `${instanceId}-${suffix}.md`);
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}

/**
 * Append a timestamped entry to the owner's scratchpad.
 * Returns true on success, false if validation failed.
 */
export function appendScratch(
  coordRoot: string,
  instanceId: string,
  category: string,
  body: string,
): { ok: boolean; reason?: string; path?: string } {
  if (!ALLOWED_CATEGORIES.has(category)) {
    return { ok: false, reason: `invalid category "${category}"` };
  }
  if (!body || body.length === 0) {
    return { ok: false, reason: "body required" };
  }

  const trimmedBody =
    body.length > APPEND_BODY_CAP ? `${body.slice(0, APPEND_BODY_CAP - 3)}...` : body;
  const target = scratchPath(coordRoot, instanceId);
  const ts = nowIsoSeconds();

  let prior = "";
  if (existsSync(target)) {
    prior = readFileSync(target, "utf8");
    if (!prior.endsWith("\n")) prior += "\n";
  }
  const entry = `## [${ts}] ${category}\n${trimmedBody}\n`;
  atomicWriteText(target, prior + entry);
  return { ok: true, path: target };
}

/**
 * Replace the scratchpad with new body, archiving prior contents and
 * appending an "(edited via UI by the operator)" audit-marker note.
 */
export function editScratchpad(
  coordRoot: string,
  instanceId: string,
  newBody: string,
  summary: string,
): { ok: boolean; reason?: string; archivePath?: string; path?: string } {
  if (typeof newBody !== "string") {
    return { ok: false, reason: "newBody required" };
  }
  const target = scratchPath(coordRoot, instanceId);
  const ts = nowIsoSeconds();
  const archiveSuffix = `pre-ui-${ts.replace(/:/g, "-")}`;
  const archive = archivePath(coordRoot, instanceId, archiveSuffix);

  mkdirSync(dirname(archive), { recursive: true });

  let prior = "";
  if (existsSync(target)) {
    try {
      copyFileSync(target, archive);
    } catch {
      /* archive optional; continue */
    }
    prior = readFileSync(target, "utf8");
    if (!prior.endsWith("\n")) prior += "\n";
  }

  const summaryText = summary && summary.length > 0 ? summary : "(no summary)";
  const auditMarker =
    `## [${ts}] note (edited via UI by the operator)\n` +
    `${summaryText}\n` +
    `Pre-edit archived at .harnery/scratch/archived/${instanceId}-${archiveSuffix}.md\n\n`;

  atomicWriteText(target, prior + auditMarker + newBody + (newBody.endsWith("\n") ? "" : "\n"));
  return { ok: true, archivePath: archive, path: target };
}
