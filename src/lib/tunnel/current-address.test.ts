import { describe, expect, test } from "bun:test";
import {
  detectPublicAddresses,
  parseTraceIp,
  planCurrentAddresses,
  TRACE_URL_V4,
  TRACE_URL_V6,
} from "./current-address.ts";
import type { TunnelConfig } from "./state.ts";

const trace = (ip: string) => `fl=1f1\nh=1.1.1.1\nip=${ip}\nts=1\nvisit_scheme=https\n`;

function fakeFetch(answers: Record<string, string | Error>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const answer = answers[url];
    if (answer instanceof Error || answer === undefined) throw answer ?? new Error("unreachable");
    return new Response(answer, { status: 200 });
  }) as typeof fetch;
}

describe("parseTraceIp", () => {
  test("reads the ip= line", () => {
    expect(parseTraceIp(trace("203.0.113.8"))).toBe("203.0.113.8");
    expect(parseTraceIp(trace("2601:db8:1:2::9"))).toBe("2601:db8:1:2::9");
    expect(parseTraceIp("fl=1\n")).toBeNull();
  });
});

describe("detectPublicAddresses", () => {
  test("asks Cloudflare over an IPv4 and an IPv6 literal", async () => {
    const calls: string[] = [];
    const found = await detectPublicAddresses({
      fetch: fakeFetch(
        { [TRACE_URL_V4]: trace("203.0.113.8"), [TRACE_URL_V6]: trace("2601:db8:1:2:aa::9") },
        calls,
      ),
    });
    expect(found).toEqual({ v4: "203.0.113.8", v6: "2601:db8:1:2:aa::9", failures: [] });
    expect(calls.sort()).toEqual([TRACE_URL_V4, TRACE_URL_V6].sort());
  });

  test("an IPv4-only network reports IPv6 as a failure", async () => {
    const found = await detectPublicAddresses({
      fetch: fakeFetch({ [TRACE_URL_V4]: trace("203.0.113.8") }),
      attempts: 1,
    });
    expect(found.v4).toBe("203.0.113.8");
    expect(found.v6).toBeUndefined();
    expect(found.failures).toHaveLength(1);
  });

  test("rejects an answer from the wrong family", async () => {
    const found = await detectPublicAddresses({
      fetch: fakeFetch({
        [TRACE_URL_V4]: trace("2601:db8::1"),
        [TRACE_URL_V6]: trace("203.0.113.8"),
      }),
      attempts: 1,
    });
    expect(found.v4).toBeUndefined();
    expect(found.v6).toBeUndefined();
    expect(found.failures).toHaveLength(2);
  });

  test("retries a transient failure", async () => {
    let n = 0;
    const flaky = (async () => {
      if (n++ === 0) throw new Error("reset");
      return new Response(trace("203.0.113.8"));
    }) as unknown as typeof fetch;
    const found = await detectPublicAddresses({ fetch: flaky, attempts: 2 });
    expect(found.v4 ?? found.v6).toBeDefined();
  });
});

const cfg = (allowed_ips: string[], auto_allowed?: string[]): TunnelConfig => ({
  allowed_ips,
  ...(auto_allowed ? { auto_allowed } : {}),
});

describe("planCurrentAddresses", () => {
  test("allows the IPv4 /32 and the IPv6 /64, marking both automatic", () => {
    const plan = planCurrentAddresses(cfg(["198.51.100.1"]), {
      v4: "203.0.113.8",
      v6: "2601:db8:1:2:aaaa::9",
      failures: [],
    });
    expect(plan.config.allowed_ips).toEqual([
      "198.51.100.1",
      "203.0.113.8/32",
      "2601:db8:1:2::/64",
    ]);
    expect(plan.config.auto_allowed).toEqual(["203.0.113.8/32", "2601:db8:1:2::/64"]);
    expect(plan.added).toEqual(["203.0.113.8/32", "2601:db8:1:2::/64"]);
    expect(plan.changed).toBe(true);
  });

  test("the next refresh replaces only the previous automatic entries", () => {
    const plan = planCurrentAddresses(
      cfg(
        ["198.51.100.1", "203.0.113.8/32", "2601:db8:1:2::/64"],
        ["203.0.113.8/32", "2601:db8:1:2::/64"],
      ),
      { v4: "192.0.2.44", v6: "2001:db8:9:9::5", failures: [] },
    );
    expect(plan.config.allowed_ips).toEqual(["198.51.100.1", "192.0.2.44/32", "2001:db8:9:9::/64"]);
    expect(plan.removed).toEqual(["203.0.113.8/32", "2601:db8:1:2::/64"]);
  });

  test("an unchanged address is not a change, so nothing needs a reload", () => {
    const plan = planCurrentAddresses(cfg(["203.0.113.8/32"], ["203.0.113.8/32"]), {
      v4: "203.0.113.8",
      failures: [],
    });
    expect(plan.changed).toBe(false);
    expect(plan.added).toEqual([]);
    expect(plan.removed).toEqual([]);
  });

  test("an address already listed by hand stays manual and is never removed later", () => {
    const first = planCurrentAddresses(cfg(["203.0.113.8"]), { v4: "203.0.113.8", failures: [] });
    expect(first.config.allowed_ips).toEqual(["203.0.113.8"]);
    expect(first.config.auto_allowed).toEqual([]);
    const moved = planCurrentAddresses(first.config, { v4: "192.0.2.44", failures: [] });
    expect(moved.config.allowed_ips).toEqual(["203.0.113.8", "192.0.2.44/32"]);
  });

  test("a failed lookup keeps the allowlist as it was and warns", () => {
    const before = cfg(["198.51.100.1", "203.0.113.8/32"], ["203.0.113.8/32"]);
    const plan = planCurrentAddresses(before, { failures: ["IPv4: timeout", "IPv6: timeout"] });
    expect(plan.config).toBe(before);
    expect(plan.changed).toBe(false);
    expect(plan.warnings[0]).toContain("Could not detect");
    expect(plan.warnings[0]).toContain("203.0.113.8/32");
  });

  test("never empties the list: only detected families replace automatic entries", () => {
    const plan = planCurrentAddresses(
      cfg(["203.0.113.8/32", "2601:db8:1:2::/64"], ["203.0.113.8/32", "2601:db8:1:2::/64"]),
      {
        v4: "192.0.2.44",
        failures: ["IPv6: unreachable"],
      },
    );
    expect(plan.config.allowed_ips).toEqual(["192.0.2.44/32"]);
    expect(plan.warnings[0]).toContain("IPv6 was not detected");
  });
});
