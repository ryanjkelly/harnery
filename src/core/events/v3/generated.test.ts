import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkEventV3Contract } from "../../../../scripts/generate-event-v3-contract.ts";
import { canonicalJsonV3 } from "./canonical.ts";
import { EVENT_V3_CORE_EVENT_TYPES, EventV3Schema } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST, EVENT_V3_SCHEMA_LINEAGE } from "./generated.ts";

describe("generated event ledger V3 contract", () => {
  test("keeps the checked-in JSON Schema and digest synchronized", () => {
    const schemaPath = resolve(import.meta.dir, "../../../../schemas/event-v3.schema.json");
    const checkedIn = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(canonicalJsonV3(checkedIn)).toBe(canonicalJsonV3(EventV3Schema));
    const digest = `sha256:${createHash("sha256")
      .update(canonicalJsonV3(EventV3Schema))
      .digest("hex")}`;
    expect(EVENT_V3_SCHEMA_DIGEST as string).toBe(digest);
  });

  test("ends the schema lineage at the runtime digest", () => {
    const lastGroup = EVENT_V3_SCHEMA_LINEAGE.groups.at(-1);
    expect(lastGroup?.at(-1) as string | undefined).toBe(EVENT_V3_SCHEMA_DIGEST);
  });

  test("lists every lineage digest once, in non-empty groups", () => {
    const digests: string[] = EVENT_V3_SCHEMA_LINEAGE.groups.flat();
    expect(EVENT_V3_SCHEMA_LINEAGE.groups.every((group) => group.length > 0)).toBe(true);
    expect(new Set(digests).size).toBe(digests.length);
  });

  test("keeps the generated lineage equal to the committed lineage file", () => {
    const lineagePath = resolve(import.meta.dir, "../../../../schemas/event-v3-lineage.json");
    const lineage = JSON.parse(readFileSync(lineagePath, "utf8"));
    expect(lineage.format).toBe("harnery-event-v3-schema-lineage");
    expect(lineage.format_version).toBe(1);
    expect(lineage.groups).toEqual(EVENT_V3_SCHEMA_LINEAGE.groups);
  });

  test("passes the generator's check mode for this checkout", () => {
    const root = resolve(import.meta.dir, "../../../..");
    expect(
      checkEventV3Contract({ root, schema: EventV3Schema, coreTypes: EVENT_V3_CORE_EVENT_TYPES }),
    ).toEqual([]);
  });
});
