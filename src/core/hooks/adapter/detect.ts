import { coordEnv } from "../../../lib/env.ts";
import type { Adapter } from "../events/schema.ts";

/**
 * Resolve the adapter firing the hook. The dispatcher binary is always
 * invoked with `--adapter <name>` per the current wiring in each adapter's
 * settings file. `--harness` remains an accepted alias because settings files
 * written by older releases survive a package upgrade until the consumer
 * re-runs `harn init`. Returns null when neither flag is present; caller falls
 * through to the env-based fallback or skips emission.
 */
export function detectAdapter(argv: readonly string[]): Adapter | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--adapter" || a === "--harness") {
      return validate(argv[i + 1]);
    }
    if (a.startsWith("--adapter=")) {
      return validate(a.slice("--adapter=".length));
    }
    if (a.startsWith("--harness=")) {
      return validate(a.slice("--harness=".length));
    }
  }
  return validate(coordEnv("AGENT_COORD_ADAPTER") ?? coordEnv("AGENT_COORD_HARNESS"));
}

function validate(v: string | undefined): Adapter | null {
  if (v === "claude-code" || v === "cursor" || v === "codex") return v;
  // Legacy: some adapters use `claude_code` (underscore). Map
  // it through so the env-based fallback works for callers that haven't
  // updated yet.
  if (v === "claude_code") return "claude-code";
  return null;
}
