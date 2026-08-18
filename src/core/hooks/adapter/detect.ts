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
 * True when the current process was spawned by a Cursor agent runtime, which
 * exports CURSOR_AGENT=1 into every hook process it launches.
 */
export function isCursorRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CURSOR_AGENT === "1";
}

/**
 * On a host wired for multiple adapters, Cursor also executes the Claude Code
 * project hooks, so a `--adapter claude-code` invocation can arrive from a
 * Cursor runtime. Recording it would mint a twin generation for the same
 * instance (plus a stream of missing_session_start diagnostics on the
 * claude-code producer), so the hook CLI skips that dispatch entirely.
 */
export function shouldSkipHookAdapter(
  adapter: Adapter | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return adapter === "claude-code" && isCursorRuntime(env);
}
