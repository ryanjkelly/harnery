import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJsonV3 } from "./canonical.ts";
import { EventV3Schema } from "./contract.ts";
import { EVENT_V3_SCHEMA_DIGEST } from "./generated.ts";

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
});
