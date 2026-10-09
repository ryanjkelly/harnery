// This machine's public addresses as Cloudflare sees them, and the allowlist
// bookkeeping around them (`tunnel allow add --current`).
//
// The tunnel gate admits a visitor by the `CF-Connecting-IP` header, which is
// the address Cloudflare saw. Asking Cloudflare's own trace endpoint therefore
// returns the same address the gate will later compare, with no third party and
// no guess about NAT. The IPv4 and IPv6 probes use address literals, so each
// travels over the family it is named for and needs no DNS.
//
// Entries the refresh adds are recorded in `auto_allowed`. The next refresh
// replaces exactly those, so a machine that changes network does not pile up
// stale addresses, and an entry added by hand is never removed.

import { ipv4Slash32, ipv6Slash64, normalizeAllowEntry } from "./allowlist.ts";
import type { TunnelConfig } from "./state.ts";

export const TRACE_URL_V4 = "https://1.1.1.1/cdn-cgi/trace";
export const TRACE_URL_V6 = "https://[2606:4700:4700::1111]/cdn-cgi/trace";

export interface DetectedAddresses {
  v4?: string;
  v6?: string;
  /** One note per family that could not be read. */
  failures: string[];
}

export interface DetectOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Tries per family; a transient failure on a flaky network should not drop an address. */
  attempts?: number;
}

/** The `ip=` value of a Cloudflare trace body, or null. */
export function parseTraceIp(body: string): string | null {
  const m = body.match(/^ip=(\S+)\s*$/m);
  return m ? (m[1] as string) : null;
}

async function probe(url: string, family: 4 | 6, opts: Required<DetectOptions>): Promise<string> {
  let last = "no answer";
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    try {
      const res = await opts.fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ip = parseTraceIp(await res.text());
      if (!ip) throw new Error("the trace had no ip= line");
      const entry = family === 4 ? ipv4Slash32(ip) : ipv6Slash64(ip);
      if (!entry) throw new Error(`expected an IPv${family} address, got ${ip}`);
      return ip;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(last);
}

/** Both families in parallel. A family that fails is reported, not thrown. */
export async function detectPublicAddresses(
  options: DetectOptions = {},
): Promise<DetectedAddresses> {
  const opts: Required<DetectOptions> = {
    fetch: options.fetch ?? fetch,
    timeoutMs: options.timeoutMs ?? 4_000,
    attempts: options.attempts ?? 2,
  };
  const [v4, v6] = await Promise.allSettled([
    probe(TRACE_URL_V4, 4, opts),
    probe(TRACE_URL_V6, 6, opts),
  ]);
  const out: DetectedAddresses = { failures: [] };
  if (v4.status === "fulfilled") out.v4 = v4.value;
  else out.failures.push(`IPv4: ${(v4.reason as Error).message}`);
  if (v6.status === "fulfilled") out.v6 = v6.value;
  else out.failures.push(`IPv6: ${(v6.reason as Error).message}`);
  return out;
}

export interface CurrentAddressPlan {
  config: TunnelConfig;
  /** Entries newly present in the allowlist. */
  added: string[];
  /** Automatic entries from an earlier refresh that are now gone. */
  removed: string[];
  /** The automatic entries after this refresh (the detected, not already listed by hand). */
  automatic: string[];
  changed: boolean;
  warnings: string[];
}

const sameEntry = (a: string, b: string) =>
  (normalizeAllowEntry(a) ?? a) === (normalizeAllowEntry(b) ?? b);
const includesEntry = (list: readonly string[], entry: string) =>
  list.some((e) => sameEntry(e, entry));

/**
 * Fold freshly detected addresses into the allowlist.
 *
 * When nothing was detected the config comes back untouched with a warning:
 * a failed lookup must never empty the list. When at least one family was
 * detected, a family that was not is treated as absent from this network, so
 * its old automatic entry goes. The entries for the detected families replace
 * every previous automatic entry; manual entries are kept in place.
 */
export function planCurrentAddresses(
  config: TunnelConfig,
  detected: DetectedAddresses,
): CurrentAddressPlan {
  const previousAuto = config.auto_allowed ?? [];
  const wanted: string[] = [];
  if (detected.v4) {
    const entry = ipv4Slash32(detected.v4);
    if (entry) wanted.push(entry);
  }
  if (detected.v6) {
    const entry = ipv6Slash64(detected.v6);
    if (entry) wanted.push(entry);
  }

  if (wanted.length === 0) {
    return {
      config,
      added: [],
      removed: [],
      automatic: previousAuto,
      changed: false,
      warnings: [
        `Could not detect this machine's public address (${detected.failures.join("; ") || "no answer"}). ` +
          `The allowlist is unchanged${previousAuto.length ? `; the previous automatic entries stay: ${previousAuto.join(", ")}` : ""}.`,
      ],
    };
  }

  const manual = config.allowed_ips.filter((e) => !includesEntry(previousAuto, e));
  // An address already listed by hand stays manual, so a later refresh keeps it.
  const automatic = wanted.filter((e) => !includesEntry(manual, e));
  const allowed = [...manual, ...automatic];
  const before = config.allowed_ips;
  const added = allowed.filter((e) => !includesEntry(before, e));
  const removed = before.filter((e) => !includesEntry(allowed, e));
  const warnings: string[] = [];
  const missing = [detected.v4 ? null : "IPv4", detected.v6 ? null : "IPv6"].filter(Boolean);
  if (missing.length > 0) {
    warnings.push(
      `${missing.join(" and ")} was not detected, so this network is treated as having none` +
        (detected.failures.length ? ` (${detected.failures.join("; ")})` : "") +
        ".",
    );
  }
  return {
    config: { ...config, allowed_ips: allowed, auto_allowed: automatic },
    added,
    removed,
    automatic,
    changed: added.length > 0 || removed.length > 0,
    warnings,
  };
}
