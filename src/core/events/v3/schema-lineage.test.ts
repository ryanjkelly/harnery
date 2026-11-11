import { describe, expect, test } from "bun:test";
import { EVENT_V3_SCHEMA_DIGEST, EVENT_V3_SCHEMA_LINEAGE } from "./generated.ts";
import {
  acceptedSchemaDigestsV3,
  type EventV3SchemaLineageV3,
  epochCompatibilityV3,
  runtimeSchemaGroupV3,
  schemaGroupForDigestV3,
} from "./schema-lineage.ts";

const digest = (fill: string) => `sha256:${fill.repeat(64)}` as const;
const lineage: EventV3SchemaLineageV3 = {
  groups: [[digest("1")], [digest("2"), digest("3")], [digest("4"), digest("5"), digest("6")]],
};

describe("event ledger V3 schema lineage", () => {
  test("finds a digest's group and position", () => {
    expect(schemaGroupForDigestV3(digest("1"), lineage)).toEqual({
      group_index: 0,
      position: 0,
      group: [digest("1")],
    });
    expect(schemaGroupForDigestV3(digest("3"), lineage)).toMatchObject({
      group_index: 1,
      position: 1,
    });
    expect(schemaGroupForDigestV3(digest("6"), lineage)?.group).toEqual([
      digest("4"),
      digest("5"),
      digest("6"),
    ]);
  });

  test("returns undefined for a digest the lineage does not hold", () => {
    expect(schemaGroupForDigestV3(digest("f"), lineage)).toBeUndefined();
    expect(schemaGroupForDigestV3("not-a-digest", lineage)).toBeUndefined();
  });

  test("places the runtime digest last in the last group of the committed lineage", () => {
    const runtime = runtimeSchemaGroupV3();
    expect(runtime.group_index).toBe(EVENT_V3_SCHEMA_LINEAGE.groups.length - 1);
    expect(runtime.group.at(-1) as string | undefined).toBe(EVENT_V3_SCHEMA_DIGEST);
    expect(runtime.position).toBe(runtime.group.length - 1);
  });

  test("refuses a runtime digest the lineage does not hold", () => {
    expect(() => runtimeSchemaGroupV3(lineage, digest("f"))).toThrow();
    expect(runtimeSchemaGroupV3(lineage, digest("5"))).toMatchObject({
      group_index: 2,
      position: 1,
    });
  });

  const verdict = (genesis: string, present?: string[], runtime = digest("6")) =>
    epochCompatibilityV3(
      { genesis_schema_digest: genesis, ...(present ? { present_schema_digests: present } : {}) },
      lineage,
      runtime,
    );

  test("serves an epoch whose genesis and present digests are all in the runtime's group", () => {
    expect(verdict(digest("6"))).toEqual({
      verdict: "serve",
      reason: "epoch_schema_in_runtime_group",
    });
    expect(verdict(digest("4"), [digest("4"), digest("5"), digest("6")]).verdict).toBe("serve");
    expect(epochCompatibilityV3({ genesis_schema_digest: EVENT_V3_SCHEMA_DIGEST }).verdict).toBe(
      "serve",
    );
  });

  test("serves an epoch holding a newer digest from the runtime's own additive group", () => {
    expect(verdict(digest("4"), [digest("6")], digest("5")).verdict).toBe("serve");
  });

  test("replaces an epoch whose genesis digest is in a group before a breaking change", () => {
    expect(verdict(digest("3"))).toEqual({
      verdict: "replace_breaking",
      reason: "genesis_schema_digest_incompatible",
    });
    expect(verdict(digest("1"), [digest("1")]).verdict).toBe("replace_breaking");
  });

  test("returns unknown with reason epoch_schema_unknown for a genesis digest outside the lineage", () => {
    expect(verdict(digest("f"))).toEqual({ verdict: "unknown", reason: "epoch_schema_unknown" });
    expect(verdict(digest("6"), [], digest("3")).verdict).toBe("unknown");
  });

  test("returns unknown when any present digest is outside the lineage, even if genesis is served", () => {
    expect(verdict(digest("6"), [digest("6"), digest("f")]).verdict).toBe("unknown");
    // An older-group genesis with an unknown row is still unknown, never replaced.
    expect(verdict(digest("2"), [digest("f")]).verdict).toBe("unknown");
    // A row from an older group in an epoch the runtime's group began is unexplained.
    expect(verdict(digest("6"), [digest("2")]).verdict).toBe("unknown");
  });

  test("counts the genesis digest as present when present_schema_digests omits it", () => {
    expect(verdict(digest("f"), [digest("6")]).verdict).toBe("unknown");
    expect(verdict(digest("2"), [digest("6")]).verdict).toBe("replace_breaking");
  });

  test("accepts every digest of the runtime's group for rows", () => {
    expect(acceptedSchemaDigestsV3(lineage, digest("5"))).toEqual([
      digest("4"),
      digest("5"),
      digest("6"),
    ]);
    expect(acceptedSchemaDigestsV3()).toContain(EVENT_V3_SCHEMA_DIGEST);
  });
});
