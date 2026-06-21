import { coordEnv } from "../../../lib/env.ts";
import type { Harness } from "../events/schema.ts";

/**
 * Resolve the harness firing the hook. The dispatcher binary is always
 * invoked with `--harness <name>` per the wiring in each harness's settings
 * file (Phase 1). Returns null when the flag is missing; caller falls
 * through to the env-based fallback or skips emission.
 */
export function detectHarness(argv: readonly string[]): Harness | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--harness") {
      return validate(argv[i + 1]);
    }
    if (a.startsWith("--harness=")) {
      return validate(a.slice("--harness=".length));
    }
  }
  return validate(coordEnv("AGENT_COORD_HARNESS"));
}

function validate(v: string | undefined): Harness | null {
  if (v === "claude-code" || v === "cursor" || v === "codex") return v;
  // Legacy: some harnesses use `claude_code` (underscore). Map
  // it through so the env-based fallback works for callers that haven't
  // updated yet.
  if (v === "claude_code") return "claude-code";
  return null;
}
