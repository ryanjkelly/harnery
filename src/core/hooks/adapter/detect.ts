import { coordEnv } from "../../../lib/env.ts";
import type { Adapter } from "../../adapter.ts";

/**
 * Resolve the adapter firing the hook. The dispatcher binary is always
 * invoked with `--adapter <name>` per the current wiring in each adapter's
 * settings file. Returns null when the flag is absent; caller falls through to
 * the environment fallback or skips emission.
 */
export function detectAdapter(argv: readonly string[]): Adapter | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--adapter") {
      return validate(argv[i + 1]);
    }
    if (a.startsWith("--adapter=")) {
      return validate(a.slice("--adapter=".length));
    }
  }
  return validate(coordEnv("AGENT_COORD_ADAPTER"));
}

function validate(v: string | undefined): Adapter | null {
  if (v === "claude-code" || v === "cursor" || v === "codex") return v;
  return null;
}

/**
 * On a host wired for multiple adapters, Cursor also executes the Claude Code
 * project hooks, piping them the same payload as its own hooks. Recording that
 * stray `--adapter claude-code` dispatch mints a twin generation for the same
 * instance (plus a stream of missing_session_start diagnostics), so the hook
 * CLI skips it entirely.
 *
 * Detection reads the payload, not the environment: every hook payload Cursor
 * emits carries a top-level `cursor_version` string (its dispatch envelope),
 * and no Claude Code payload does. Environment sniffing cannot make this call
 * in either direction — Cursor's own hook processes do not carry CURSOR_AGENT
 * (only its agent tool shells do), and a genuine Claude Code session nested
 * under a Cursor agent shell inherits Cursor-flavored variables it must not
 * be skipped for. The check is the top-level key only: a Claude Code payload
 * whose tool_input merely mentions the string must not match.
 */
export function shouldSkipHookAdapter(adapter: Adapter | null, rawPayload: string): boolean {
  if (adapter !== "claude-code") return false;
  if (!rawPayload || rawPayload.trim().length === 0) return false;
  try {
    const json = JSON.parse(rawPayload) as Record<string, unknown>;
    return typeof json.cursor_version === "string" && json.cursor_version.length > 0;
  } catch {
    return false;
  }
}
