/**
 * Per-harness CLI metadata: binary names plus install/login hints, shared by
 * the spawn adapters (a not-found error should say how to fix it, not just
 * that it happened) and `harn doctor`'s workflow-harness checks.
 *
 * Install commands are the vendors' official one-liners; they drift rarely
 * but they do drift — keep this module the single place they live.
 */

import type { HarnessName } from "./types.ts";

export const HARNESS_BINARIES: Record<HarnessName, string> = {
  "claude-code": "claude",
  codex: "codex",
  cursor: "cursor-agent",
};

export const HARNESS_INSTALL_HINTS: Record<HarnessName, string> = {
  "claude-code": "npm install -g @anthropic-ai/claude-code",
  codex: "npm install -g @openai/codex",
  cursor: "curl https://cursor.com/install -fsS | bash",
};

/** How to authenticate each CLI with a subscription login (the billing
 * default — see billing.ts). */
export const HARNESS_LOGIN_HINTS: Record<HarnessName, string> = {
  "claude-code": "run `claude` and use /login",
  codex: "codex login",
  cursor: "cursor-agent login",
};

/** One-line "it's missing, here's the fix" string for spawn adapters. */
export function notFoundError(harness: HarnessName): string {
  return (
    `${HARNESS_BINARIES[harness]} CLI not found on PATH; ` +
    `install: ${HARNESS_INSTALL_HINTS[harness]}  then authenticate: ${HARNESS_LOGIN_HINTS[harness]}`
  );
}
