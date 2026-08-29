import { describe, expect, test } from "bun:test";
import { harneryStorageFamilies } from "./builtins.ts";
import {
  HarneryStoragePolicyError,
  validateFamilyPolicy,
  validateStoragePolicy,
} from "./policy.ts";

describe("storage policy validation", () => {
  test("accepts every source-owned policy", () => {
    for (const family of harneryStorageFamilies()) {
      expect(() => validateFamilyPolicy(family)).not.toThrow();
    }
  });

  test("requires a reason for every unbounded dimension", () => {
    const policy = structuredClone(harneryStorageFamilies()[0]!.policy);
    policy.retention.max_bytes = { limit: null, unit: "bytes" };
    expect(() => validateStoragePolicy(policy)).toThrow(HarneryStoragePolicyError);
  });

  test("rejects malformed limits and unit mismatches", () => {
    const policy = structuredClone(harneryStorageFamilies()[0]!.policy);
    policy.records.max_record_bytes = { limit: -1, unit: "bytes" };
    expect(() => validateStoragePolicy(policy)).toThrow("positive safe integer");
    policy.records.max_record_bytes = { limit: 1, unit: "records" };
    expect(() => validateStoragePolicy(policy)).toThrow("must use bytes");
  });

  test("requires repairable caches to name their reconstruction source", () => {
    const source = harneryStorageFamilies().find((family) => family.id === "semantic-cache")!;
    const family = { ...source, policy: { ...source.policy, reconstruction_source: undefined } };
    expect(() => validateFamilyPolicy(family)).toThrow("must name its reconstruction source");
  });
});
