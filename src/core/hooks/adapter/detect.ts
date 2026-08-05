import { coordEnv } from "../../../lib/env.ts";
import type { Adapter } from "../events/schema.ts";

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
