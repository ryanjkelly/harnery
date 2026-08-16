import { describe, expect, test } from "bun:test";
import { canonicalJsonV2, fingerprintV2, normalizeNativeIdV2 } from "./canonical.ts";

describe("event ledger V2 canonicalization", () => {
  test("sorts keys lexically and normalizes Unicode to NFC", () => {
    expect(canonicalJsonV2({ "2": "e\u0301", "10": "x", z: [true, null] })).toBe(
      '{"10":"x","2":"é","z":[true,null]}',
    );
  });

  test("rejects silent JSON coercions and cycles", () => {
    expect(() => canonicalJsonV2({ missing: undefined })).toThrow("rejects undefined");
    expect(() => canonicalJsonV2(Number.NaN)).toThrow("non-finite");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonV2(cyclic)).toThrow("cycles");
  });

  test("uses domain-separated deterministic HMACs without serializing native IDs", () => {
    const context = {
      epochId: "pep_fixture" as const,
      epochKey: Buffer.alloc(32, 0x19),
      rootId: "root_fixture" as const,
      generationId: "gen_019c0f65-7c18-7000-8000-000000000001" as const,
    };
    const first = fingerprintV2(context, "exact-input", { b: 2, a: 1 });
    const same = fingerprintV2(context, "exact-input", { a: 1, b: 2 });
    const otherDomain = fingerprintV2(context, "semantic-target", { a: 1, b: 2 });
    expect(first).toEqual(same);
    expect(first.digest).not.toBe(otherDomain.digest);
    const normalized = normalizeNativeIdV2(context, "session", "account@example.com");
    expect(normalized).toMatch(/^hid_[a-f0-9]{64}$/);
    expect(normalized).not.toContain("account");
  });
});
