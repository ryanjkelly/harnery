/**
 * Display-name resolution for the coord layer.
 *
 * This module once housed `coordLog`, the writer for a human-readable
 * activity log. That log has been retired; the canonical V2 ledger is the
 * single source of truth, and the
 * per-event telemetry that had consumers (heals → health.*, councils →
 * council.*, shell-mutation candidates → decision.warn) is emitted there
 * directly. `coordLog` and its call sites are gone; only `resolveShortName`
 * remains (still used for display-name resolution).
 */

import { readLiveCoordinationRow } from "./live-coordination-view.ts";

/**
 * Resolve `agent-<name>` display string. Looks up the V2 projection's `name`
 * field; falls back to `agent-<8-char-hex>` if name is empty (mirrors bash
 * coord_owner_short). Returns `agent-unknown` when instanceId is null.
 */
export function resolveShortName(coordRoot: string, instanceId: string | null): string {
  if (!instanceId) return "agent-unknown";
  const row = readLiveCoordinationRow(coordRoot, instanceId);
  if (row?.name) return `agent-${row.name}`;
  return `agent-${instanceId.slice(0, 8)}`;
}
