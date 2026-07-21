/**
 * Per-harness CLI metadata: binary names plus install/login hints, shared by
 * the spawn adapters (a not-found error should say how to fix it, not just
 * that it happened) and `harn doctor`'s workflow-harness checks.
 *
 * Install commands are the vendors' official one-liners; they drift rarely
 * but they do drift — keep this module the single place they live.
 */

import { BUILTIN_HARNESS_PROFILES } from "../harnesses/profiles.ts";
import type { HarnessName } from "./types.ts";

export const HARNESS_BINARIES: Record<string, string> = Object.fromEntries(
  Object.values(BUILTIN_HARNESS_PROFILES).map((profile) => [profile.id, profile.binary]),
);

export const HARNESS_INSTALL_HINTS: Record<string, string> = Object.fromEntries(
  Object.values(BUILTIN_HARNESS_PROFILES).map((profile) => [profile.id, profile.installHint]),
);

/** How to authenticate each CLI with a subscription login (the billing
 * default — see billing.ts). */
export const HARNESS_LOGIN_HINTS: Record<string, string> = Object.fromEntries(
  Object.values(BUILTIN_HARNESS_PROFILES).map((profile) => [profile.id, profile.loginHint]),
);

/** One-line "it's missing, here's the fix" string for spawn adapters. */
export function notFoundError(harness: HarnessName): string {
  const binary = HARNESS_BINARIES[harness] ?? harness;
  const install = HARNESS_INSTALL_HINTS[harness] ?? "install the harness CLI";
  const login = HARNESS_LOGIN_HINTS[harness] ?? "authenticate the harness CLI";
  return `${binary} CLI not found on PATH; ` + `install: ${install}  then authenticate: ${login}`;
}
