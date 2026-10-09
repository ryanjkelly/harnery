// Address allowlist for the tunnel gate: exact addresses and CIDR ranges, IPv4
// and IPv6. Pure functions with no I/O, shared by the gate worker (matching)
// and the `tunnel allow` commands (validation + canonical spelling).
//
// An IPv6 phone and laptop on one Wi-Fi network have different addresses but
// share a /64 prefix, so a range entry such as `2601:db8:1:2::/64` admits both.
// An entry without a prefix length is a single address (/32 or /128).
//
// IPv4-mapped IPv6 addresses (`::ffff:203.0.113.8`) are IPv4 addresses reached
// through a dual-stack socket, so they parse and match as IPv4.

import { isIPv4, isIPv6 } from "node:net";

export type IpFamily = 4 | 6;

export interface ParsedIp {
  family: IpFamily;
  value: bigint;
}

export interface AllowEntry extends ParsedIp {
  /** Prefix length in bits (32 or 128 for a single address). */
  prefix: number;
}

const FULL_BITS: Record<IpFamily, number> = { 4: 32, 6: 128 };

function parseIpv4(text: string): bigint | null {
  if (!isIPv4(text)) return null;
  let value = 0n;
  for (const part of text.split(".")) value = (value << 8n) | BigInt(Number(part));
  return value;
}

function parseIpv6(text: string): bigint | null {
  if (!isIPv6(text)) return null;
  let rest = text;
  // A trailing dotted quad (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is two groups.
  const dotted = rest.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = parseIpv4(dotted[2] as string);
    if (v4 === null) return null;
    rest = `${dotted[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? (halves[0] as string).split(":") : [];
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...tail,
  ];
  if (groups.length !== 8) return null;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

/**
 * Parse one address. Returns null for anything that is not an IP literal. A
 * zone id (`fe80::1%en0`) is dropped, and an IPv4-mapped IPv6 address is
 * reported as the IPv4 address it carries.
 */
export function parseIp(raw: string): ParsedIp | null {
  let text = raw.trim();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  if (!text) return null;
  const v4 = parseIpv4(text);
  if (v4 !== null) return { family: 4, value: v4 };
  const v6 = parseIpv6(text);
  if (v6 === null) return null;
  if (v6 >> 32n === 0xffffn) return { family: 4, value: v6 & 0xffffffffn };
  return { family: 6, value: v6 };
}

function maskFor(family: IpFamily, prefix: number): bigint {
  const bits = BigInt(FULL_BITS[family]);
  const host = bits - BigInt(prefix);
  return ((1n << bits) - 1n) ^ ((1n << host) - 1n);
}

/**
 * Parse an allowlist entry: `203.0.113.8`, `203.0.113.0/24`, `2601:db8::1`, or
 * `2601:db8:1:2::/64`. Host bits below the prefix are cleared, so
 * `203.0.113.77/24` means the network `203.0.113.0/24`. Returns null when the
 * entry is not a valid address or its prefix length is out of range.
 */
export function parseAllowEntry(raw: string): AllowEntry | null {
  const text = raw.trim();
  const slash = text.indexOf("/");
  const address = parseIp(slash === -1 ? text : text.slice(0, slash));
  if (!address) return null;
  let prefix = FULL_BITS[address.family];
  if (slash !== -1) {
    const lengthText = text.slice(slash + 1);
    if (!/^\d{1,3}$/.test(lengthText)) return null;
    prefix = Number(lengthText);
    // A prefix on an IPv4-mapped IPv6 entry counts from the IPv6 start, so
    // `::ffff:1.2.3.0/120` is the IPv4 /24. Anything shorter is not an IPv4 range.
    if (address.family === 4 && /:/.test(text.slice(0, slash))) {
      if (prefix < 96 || prefix > 128) return null;
      prefix -= 96;
    }
    if (prefix > FULL_BITS[address.family]) return null;
  }
  return { ...address, prefix, value: address.value & maskFor(address.family, prefix) };
}

function compress(groups: number[]): string {
  // RFC 5952: collapse the longest run of two or more zero groups (first wins).
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(":");
  const left = groups.slice(0, bestStart).map((g) => g.toString(16));
  const right = groups.slice(bestStart + bestLen).map((g) => g.toString(16));
  return `${left.join(":")}::${right.join(":")}`;
}

/** Canonical text of an address (dotted quad, or compressed lowercase IPv6). */
export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => Number((ip.value >> shift) & 0xffn)).join(".");
  }
  const groups: number[] = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((ip.value >> BigInt(i * 16)) & 0xffffn));
  return compress(groups);
}

/** Canonical text of an entry; a single address carries no `/len` suffix. */
export function formatAllowEntry(entry: AllowEntry): string {
  const address = formatIp(entry);
  return entry.prefix === FULL_BITS[entry.family] ? address : `${address}/${entry.prefix}`;
}

/**
 * Canonical spelling of an allowlist entry, or null when invalid. Two spellings
 * of one address or range (`2601:DB8:0:0::1`, `2601:db8::1`) normalize equal.
 */
export function normalizeAllowEntry(raw: string): string | null {
  const entry = parseAllowEntry(raw);
  return entry ? formatAllowEntry(entry) : null;
}

export interface Allowlist {
  entries: AllowEntry[];
  /** Entries that could not be parsed; they never match anything. */
  invalid: string[];
}

export function compileAllowlist(rawEntries: readonly string[]): Allowlist {
  const entries: AllowEntry[] = [];
  const invalid: string[] = [];
  for (const raw of rawEntries) {
    const text = raw.trim();
    if (!text) continue;
    const entry = parseAllowEntry(text);
    if (entry) entries.push(entry);
    else invalid.push(text);
  }
  return { entries, invalid };
}

/** True when `ip` lies inside any entry. A missing or malformed address never matches. */
export function allowlistMatches(list: Allowlist, ip: string): boolean {
  const address = parseIp(ip);
  if (!address) return false;
  for (const entry of list.entries) {
    if (entry.family !== address.family) continue;
    const mask = maskFor(entry.family, entry.prefix);
    if ((address.value & mask) === entry.value) return true;
  }
  return false;
}

/** The IPv6 /64 network prefix of an address, as a canonical `…/64` entry. */
export function ipv6Slash64(address: string): string | null {
  const ip = parseIp(address);
  if (!ip || ip.family !== 6) return null;
  return formatAllowEntry({ ...ip, prefix: 64, value: ip.value & maskFor(6, 64) });
}

/** A single IPv4 address as a `/32` entry. */
export function ipv4Slash32(address: string): string | null {
  const ip = parseIp(address);
  if (!ip || ip.family !== 4) return null;
  return `${formatIp(ip)}/32`;
}
