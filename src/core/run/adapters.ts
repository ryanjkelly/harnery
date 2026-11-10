/**
 * Per-adapter CLI metadata: binary names plus install/login hints, shared by
 * the spawn adapters (a not-found error should say how to fix it, not just
 * that it happened) and `harn doctor`'s workflow-adapter checks.
 *
 * Install commands are the vendors' official one-liners; they drift rarely
 * but they do drift — keep this module the single place they live.
 */

import type { Adapter } from "../adapter.ts";
import { probeBinaryVersion } from "../adapters/bench.ts";
import { BUILTIN_ADAPTER_PROFILES } from "../adapters/profiles.ts";
import type { AdapterName } from "./types.ts";

export const ADAPTER_BINARIES: Record<string, string> = Object.fromEntries(
  Object.values(BUILTIN_ADAPTER_PROFILES).map((profile) => [profile.id, profile.binary]),
);

export const ADAPTER_INSTALL_HINTS: Record<string, string> = Object.fromEntries(
  Object.values(BUILTIN_ADAPTER_PROFILES).map((profile) => [profile.id, profile.installHint]),
);

/** How to authenticate each CLI with a subscription login (the billing
 * default — see billing.ts). */
export const ADAPTER_LOGIN_HINTS: Record<string, string> = Object.fromEntries(
  Object.values(BUILTIN_ADAPTER_PROFILES).map((profile) => [profile.id, profile.loginHint]),
);

/**
 * Adapter ids whose CLI answers a version probe on this machine's PATH, in
 * `BUILTIN_ADAPTER_PROFILES` order. The probe is injectable so callers can keep
 * tests deterministic instead of keying on the host's toolchain.
 */
export function detectInstalledAdapters(
  probe: (binary: string) => unknown = probeBinaryVersion,
): Adapter[] {
  return (Object.keys(ADAPTER_BINARIES) as Adapter[]).filter(
    (id) => probe(ADAPTER_BINARIES[id]) !== null,
  );
}

/** One-line "it's missing, here's the fix" string for spawn adapters. */
export function notFoundError(adapter: AdapterName): string {
  const binary = ADAPTER_BINARIES[adapter] ?? adapter;
  const install = ADAPTER_INSTALL_HINTS[adapter] ?? "install the adapter CLI";
  const login = ADAPTER_LOGIN_HINTS[adapter] ?? "authenticate the adapter CLI";
  return `${binary} CLI not found on PATH; ` + `install: ${install}  then authenticate: ${login}`;
}
