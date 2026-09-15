import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commandPaceGate,
  DEFAULT_PACE_MAX_MS,
  DEFAULT_PACE_MIN_MS,
  describePaceWait,
  PaceGate,
  type PacePolicy,
  pacePolicyFromEnv,
  paceSiteKey,
} from "./pace.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ledgerDir(): string {
  const d = mkdtempSync(join(tmpdir(), "harnery-pace-"));
  dirs.push(d);
  return d;
}

function policy(overrides: Partial<PacePolicy> = {}): PacePolicy {
  return {
    enabled: true,
    minMs: 1_000,
    maxMs: 1_000,
    exemptSuffixes: [],
    ledgerPath: join(ledgerDir(), "pace.json"),
    ...overrides,
  };
}

/** A gate with a controllable clock so reservation math is deterministic. */
function clockGate(p: PacePolicy, waits: number[] = []) {
  let t = 1_000_000;
  const gate = new PaceGate(p, {
    now: () => t,
    random: () => 0,
    onWait: (w) => waits.push(w.waitMs),
  });
  return { gate, advance: (ms: number) => (t += ms), waits };
}

describe("pacePolicyFromEnv", () => {
  test("is on by default with the documented window", () => {
    const p = pacePolicyFromEnv({});
    expect(p.enabled).toBe(true);
    expect(p.minMs).toBe(DEFAULT_PACE_MIN_MS);
    expect(p.maxMs).toBe(DEFAULT_PACE_MAX_MS);
    expect(p.exemptSuffixes).toEqual([]);
    expect(p.ledgerPath.endsWith(join(".cache", "harnery", "pace.json"))).toBe(true);
  });

  test("HARNERY_PACE=off and its aliases disable the gate; human keeps it", () => {
    for (const v of ["off", "0", "false", "no", "OFF"]) {
      expect(pacePolicyFromEnv({ HARNERY_PACE: v }).enabled).toBe(false);
    }
    expect(pacePolicyFromEnv({ HARNERY_PACE: "human" }).enabled).toBe(true);
    expect(() => pacePolicyFromEnv({ HARNERY_PACE: "fast" })).toThrow('"human" or "off"');
  });

  test("reads and validates the window, exemptions, and ledger override", () => {
    const p = pacePolicyFromEnv({
      HARNERY_PACE_MIN_MS: "500",
      HARNERY_PACE_MAX_MS: "700",
      HARNERY_PACE_EXEMPT: " Intranet.Example.COM, ,staging.site. ",
      HARNERY_PACE_LEDGER: "/tmp/x/pace.json",
    });
    expect(p.minMs).toBe(500);
    expect(p.maxMs).toBe(700);
    expect(p.exemptSuffixes).toEqual(["intranet.example.com", "staging.site"]);
    expect(p.ledgerPath).toBe("/tmp/x/pace.json");
    expect(() => pacePolicyFromEnv({ HARNERY_PACE_MIN_MS: "abc" })).toThrow("non-negative integer");
    expect(() =>
      pacePolicyFromEnv({ HARNERY_PACE_MIN_MS: "900", HARNERY_PACE_MAX_MS: "100" }),
    ).toThrow("must not exceed");
  });
});

describe("paceSiteKey", () => {
  test("groups hosts by registrable site", () => {
    expect(paceSiteKey("https://www.linkedin.com/feed/")).toBe("linkedin.com");
    expect(paceSiteKey("https://linkedin.com/")).toBe("linkedin.com");
    expect(paceSiteKey("http://News.BBC.co.uk./x")).toBe("bbc.co.uk");
    expect(paceSiteKey("https://a.b.c.example.com")).toBe("example.com");
    expect(paceSiteKey("https://203.0.113.9/")).toBe("203.0.113.9");
    expect(paceSiteKey("https://[2001:db8::1]/")).toBe("[2001:db8::1]");
  });

  test("exempts local, private, reserved, and non-http targets", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://app.localhost/",
      "http://127.0.0.1:8080/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.10/",
      "http://169.254.1.1/",
      "http://0.0.0.0/",
      "http://[::1]:5173/",
      "http://[fd12::1]/",
      "http://[fe80::1]/",
      "http://intranet/",
      "https://site.test/",
      "https://svc.internal/",
      "https://host.local/",
      "file:///tmp/page.html",
      "data:text/html,hi",
      "about:blank",
      "not a url",
    ]) {
      expect(paceSiteKey(url)).toBeNull();
    }
    expect(paceSiteKey("http://172.32.0.1/")).toBe("172.32.0.1");
  });

  test("honors configured exempt suffixes", () => {
    expect(paceSiteKey("https://qa.mysite.example.org/", ["mysite.example.org"])).toBeNull();
    expect(paceSiteKey("https://mysite.example.org/", ["mysite.example.org"])).toBeNull();
    expect(paceSiteKey("https://other.example.org/", ["mysite.example.org"])).toBe("example.org");
  });
});

describe("PaceGate reservations", () => {
  test("first load is free, the next load of the same site owes the gap", () => {
    const { gate, advance, waits } = clockGate(policy());
    expect(gate.reserve("https://www.linkedin.com/")?.waitMs).toBe(0);
    expect(gate.reserve("https://linkedin.com/in/x")?.waitMs).toBe(1_000);
    // Two callers queued: the second waits for the first's slot plus its own gap.
    expect(gate.reserve("https://linkedin.com/in/y")?.waitMs).toBe(2_000);
    advance(3_000);
    expect(gate.reserve("https://linkedin.com/in/z")?.waitMs).toBe(0);
    expect(waits).toEqual([0, 1_000, 2_000, 0]);
  });

  test("different sites do not wait on each other", () => {
    const { gate } = clockGate(policy());
    gate.reserve("https://one.example.com/");
    expect(gate.reserve("https://two.example.net/")?.waitMs).toBe(0);
  });

  test("returns null for exempt URLs and disabled gates without touching the ledger", () => {
    const p = policy();
    const { gate } = clockGate(p);
    expect(gate.reserve("http://localhost:3000/")).toBeNull();
    expect(new PaceGate({ ...p, enabled: false }).reserve("https://example.com/")).toBeNull();
    expect(PaceGate.disabled().reserve("https://example.com/")).toBeNull();
    expect(existsSync(p.ledgerPath)).toBe(false);
  });

  test("the ledger is shared across gate instances, as it is across processes", () => {
    const p = policy();
    const a = clockGate(p);
    a.gate.reserve("https://example.com/");
    const b = clockGate(p);
    expect(b.gate.reserve("https://www.example.com/page")?.waitMs).toBe(1_000);
    expect(existsSync(`${p.ledgerPath}.lock`)).toBe(false);
    const ledger = JSON.parse(readFileSync(p.ledgerPath, "utf8"));
    expect(ledger.version).toBe(1);
    expect(Object.keys(ledger.sites)).toEqual(["example.com"]);
  });

  test("draws the gap from the configured window", () => {
    const p = policy({ minMs: 2_000, maxMs: 6_000 });
    let t = 0;
    const gate = new PaceGate(p, { now: () => t, random: () => 0.5 });
    gate.reserve("https://example.com/");
    t = 100;
    expect(gate.reserve("https://example.com/2")?.waitMs).toBe(3_900);
  });

  test("tolerates a corrupt ledger and prunes stale entries", () => {
    const p = policy();
    writeFileSync(p.ledgerPath, "{not json");
    const { gate, advance } = clockGate(p);
    expect(gate.reserve("https://old.example.com/")?.waitMs).toBe(0);
    advance(2 * 60 * 60 * 1_000);
    gate.reserve("https://fresh.example.org/");
    const ledger = JSON.parse(readFileSync(p.ledgerPath, "utf8"));
    expect(Object.keys(ledger.sites)).toEqual(["example.org"]);
  });

  test("before() and beforeSync() actually wait", async () => {
    const p = policy({ minMs: 40, maxMs: 40 });
    const gate = new PaceGate(p);
    await gate.before("https://example.com/");
    const t0 = Date.now();
    const wait = await gate.before("https://example.com/2");
    expect(wait?.waitMs).toBeGreaterThan(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(wait!.waitMs - 5);
    const t1 = Date.now();
    const sync = gate.beforeSync("https://example.com/3");
    expect(sync?.waitMs).toBeGreaterThan(0);
    expect(Date.now() - t1).toBeGreaterThanOrEqual(sync!.waitMs - 5);
  });
});

describe("command integration", () => {
  test("commandPaceGate returns null for --no-pace and logs only real waits", () => {
    expect(commandPaceGate(false, () => {})).toBeNull();
    const saved = { ...process.env };
    process.env.HARNERY_PACE = "human";
    process.env.HARNERY_PACE_LEDGER = join(ledgerDir(), "pace.json");
    process.env.HARNERY_PACE_MIN_MS = "4200";
    process.env.HARNERY_PACE_MAX_MS = "4200";
    try {
      const logs: string[] = [];
      const gate = commandPaceGate(true, (m) => logs.push(m));
      expect(gate).toBeInstanceOf(PaceGate);
      expect(gate?.reserve("https://example.com/")?.waitMs).toBe(0);
      expect(logs).toEqual([]);
      const second = gate?.reserve("https://example.com/2");
      expect(second?.waitMs).toBeGreaterThan(4_000);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(
        /^paced 4\.[12]s before example\.com \(human pace; --no-pace or HARNERY_PACE=off skips\)$/,
      );
    } finally {
      for (const key of Object.keys(process.env)) {
        if (key.startsWith("HARNERY_PACE")) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  test("describePaceWait names the site and the flags that skip it", () => {
    expect(describePaceWait({ site: "linkedin.com", waitMs: 5_250 })).toBe(
      "paced 5.3s before linkedin.com (human pace; --no-pace or HARNERY_PACE=off skips)",
    );
  });
});
