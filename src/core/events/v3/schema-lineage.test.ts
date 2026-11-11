import { describe, expect, test } from "bun:test";
import { EVENT_V3_SCHEMA_DIGEST, EVENT_V3_SCHEMA_LINEAGE } from "./generated.ts";
import {
  type EventV3SchemaLineageV3,
  epochCompatibilityV3,
  runtimeSchemaGroupV3,
  schemaGroupForDigestV3,
} from "./schema-lineage.ts";

/** Body for a case the lineage compatibility rule has not implemented yet. */
const pendingRule = () => {
  throw new Error("pending: epochCompatibilityV3 still applies the equal-digest rule");
};
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

  test("currently serves only an epoch whose genesis digest equals the runtime digest", () => {
    // The compatibility track replaces this with the lineage rule (todo cases below).
    expect(
      epochCompatibilityV3({ genesis_schema_digest: digest("6") }, lineage, digest("6")).verdict,
    ).toBe("serve");
    expect(
      epochCompatibilityV3({ genesis_schema_digest: digest("5") }, lineage, digest("6")).verdict,
    ).toBe("replace_breaking");
    expect(
      epochCompatibilityV3({ genesis_schema_digest: digest("f") }, lineage, digest("6")).verdict,
    ).toBe("replace_breaking");
    expect(epochCompatibilityV3({ genesis_schema_digest: EVENT_V3_SCHEMA_DIGEST }).verdict).toBe(
      "serve",
    );
  });

  test.todo(
    "serves an epoch whose genesis and present digests are all in the runtime's group",
    pendingRule,
  );
  test.todo(
    "serves an epoch holding a newer digest from the runtime's own additive group",
    pendingRule,
  );
  test.todo(
    "replaces an epoch whose genesis digest is in a group before a breaking change",
    pendingRule,
  );
  test.todo(
    "returns unknown with reason epoch_schema_unknown for a genesis digest outside the lineage",
    pendingRule,
  );
  test.todo(
    "returns unknown when any present digest is outside the lineage, even if genesis is served",
    pendingRule,
  );
  test.todo(
    "counts the genesis digest as present when present_schema_digests omits it",
    pendingRule,
  );
});
