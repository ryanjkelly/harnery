import { describe, expect, test } from "bun:test";
import {
  allowlistMatches,
  compileAllowlist,
  formatIp,
  ipv4Slash32,
  ipv6Slash64,
  normalizeAllowEntry,
  parseAllowEntry,
  parseIp,
} from "./allowlist.ts";

const matches = (entries: string[], ip: string) => allowlistMatches(compileAllowlist(entries), ip);

describe("parseIp", () => {
  test("reads IPv4 and IPv6 literals", () => {
    expect(parseIp("203.0.113.8")).toEqual({ family: 4, value: 0xcb007108n });
    expect(parseIp("2601:db8:1:2::1")?.family).toBe(6);
    expect(parseIp("[2601:db8::1]")?.family).toBe(6);
    expect(parseIp("fe80::1%en0")?.family).toBe(6);
  });

  test("rejects non-addresses", () => {
    for (const bad of [
      "",
      "nope",
      "1.2.3",
      "1.2.3.256",
      "2601:db8::1::2",
      "12345::1",
      "1.2.3.4/24",
    ]) {
      expect(parseIp(bad)).toBeNull();
    }
  });

  test("reports an IPv4-mapped IPv6 address as the IPv4 address it carries", () => {
    expect(parseIp("::ffff:203.0.113.8")).toEqual(parseIp("203.0.113.8"));
    expect(parseIp("::ffff:cb00:7108")).toEqual(parseIp("203.0.113.8"));
  });
});

describe("formatIp / normalizeAllowEntry", () => {
  test("normalizes every spelling of one IPv6 address to the compressed lowercase form", () => {
    for (const spelling of [
      "2601:DB8:0:0:0:0:0:1",
      "2601:db8::1",
      "2601:0db8:0000::0001",
      "[2601:db8::1]",
    ]) {
      expect(normalizeAllowEntry(spelling)).toBe("2601:db8::1");
    }
  });

  test("compresses the longest zero run and leaves a single zero group alone", () => {
    expect(formatIp(parseIp("2001:db8:0:1:0:0:0:1") as never)).toBe("2001:db8:0:1::1");
    expect(formatIp(parseIp("2001:db8:0:1:1:1:1:1") as never)).toBe("2001:db8:0:1:1:1:1:1");
    expect(formatIp(parseIp("::") as never)).toBe("::");
    expect(formatIp(parseIp("1::") as never)).toBe("1::");
  });

  test("clears host bits and keeps the prefix", () => {
    expect(normalizeAllowEntry("203.0.113.77/24")).toBe("203.0.113.0/24");
    expect(normalizeAllowEntry("2601:db8:1:2:aaaa:bbbb:cccc:dddd/64")).toBe("2601:db8:1:2::/64");
    expect(normalizeAllowEntry("203.0.113.8/32")).toBe("203.0.113.8");
  });

  test("rejects a bad prefix length", () => {
    for (const bad of [
      "203.0.113.0/33",
      "2601:db8::/129",
      "203.0.113.0/",
      "203.0.113.0/x",
      "203.0.113.0/-1",
    ]) {
      expect(parseAllowEntry(bad)).toBeNull();
    }
  });
});

describe("allowlistMatches", () => {
  test("matches an exact IPv4 address only", () => {
    expect(matches(["203.0.113.8"], "203.0.113.8")).toBe(true);
    expect(matches(["203.0.113.8"], "203.0.113.9")).toBe(false);
  });

  test("matches IPv4 CIDR ranges at their edges", () => {
    expect(matches(["203.0.113.0/24"], "203.0.113.0")).toBe(true);
    expect(matches(["203.0.113.0/24"], "203.0.113.255")).toBe(true);
    expect(matches(["203.0.113.0/24"], "203.0.114.0")).toBe(false);
    expect(matches(["203.0.113.8/32"], "203.0.113.8")).toBe(true);
    expect(matches(["0.0.0.0/0"], "198.51.100.1")).toBe(true);
  });

  test("matches an IPv6 /64 for every address on the network", () => {
    const list = ["2601:db8:1:2::/64"];
    expect(matches(list, "2601:db8:1:2::1")).toBe(true);
    expect(matches(list, "2601:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(true);
    expect(matches(list, "2601:0DB8:0001:0002:0:0:0:5")).toBe(true);
    expect(matches(list, "2601:db8:1:3::1")).toBe(false);
    expect(matches(list, "2601:db8:1:1:ffff:ffff:ffff:ffff")).toBe(false);
  });

  test("matches an exact IPv6 address spelled differently", () => {
    expect(matches(["2601:db8::1"], "2601:DB8:0:0:0:0:0:1")).toBe(true);
    expect(matches(["2601:db8::1"], "2601:db8::2")).toBe(false);
  });

  test("never matches across families", () => {
    expect(matches(["::/0"], "203.0.113.8")).toBe(false);
    expect(matches(["0.0.0.0/0"], "2601:db8::1")).toBe(false);
  });

  test("an IPv4 client arriving as an IPv4-mapped address still matches its IPv4 entry", () => {
    expect(matches(["203.0.113.0/24"], "::ffff:203.0.113.8")).toBe(true);
    expect(matches(["::ffff:203.0.113.8"], "203.0.113.8")).toBe(true);
  });

  test("a missing, empty, or malformed client address matches nothing", () => {
    expect(matches(["203.0.113.0/24", "2601:db8::/32"], "")).toBe(false);
    expect(matches(["203.0.113.0/24"], "garbage")).toBe(false);
    expect(matches([], "203.0.113.8")).toBe(false);
  });

  test("invalid entries are reported and never match", () => {
    const list = compileAllowlist(["203.0.113.8", "not-an-ip", " ", "10.0.0.0/99"]);
    expect(list.entries).toHaveLength(1);
    expect(list.invalid).toEqual(["not-an-ip", "10.0.0.0/99"]);
  });
});

describe("derived entries", () => {
  test("an IPv6 address becomes its /64, an IPv4 address its /32", () => {
    expect(ipv6Slash64("2601:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2601:db8:1:2::/64");
    expect(ipv6Slash64("203.0.113.8")).toBeNull();
    expect(ipv4Slash32("203.0.113.8")).toBe("203.0.113.8/32");
    expect(ipv4Slash32("2601:db8::1")).toBeNull();
  });
});
