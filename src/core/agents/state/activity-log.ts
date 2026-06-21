/**
 * Display-name resolution for the coord layer.
 *
 * This module once housed `coordLog`, the writer for a human-readable
 * activity log. That log has been retired; the canonical
 * `.harnery/events.ndjson` stream is the single source of truth, and the
 * per-event telemetry that had consumers (heals → health.*, councils →
 * council.*, shell-mutation candidates → decision.warn) is emitted there
 * directly. `coordLog` and its call sites are gone; only `resolveShortName`
 * remains (still used for display-name resolution).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve `agent-<name>` display string. Looks up the heartbeat's `name`
 * field; falls back to `agent-<8-char-hex>` if name is empty (mirrors bash
 * coord_owner_short). Returns `agent-unknown` when instanceId is null.
 */
export function resolveShortName(coordRoot: string, instanceId: string | null): string {
  if (!instanceId) return "agent-unknown";
  const path = join(coordRoot, ".harnery", "active", `${instanceId}.json`);
  if (existsSync(path)) {
    try {
      const hb = JSON.parse(readFileSync(path, "utf8")) as { name?: string };
      if (hb.name && hb.name.length > 0) return `agent-${hb.name}`;
    } catch {
      /* fall through to short-id */
    }
  }
  return `agent-${instanceId.slice(0, 8)}`;
}
