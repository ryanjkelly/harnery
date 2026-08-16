import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJsonV2 } from "./canonical.ts";
import { EventV2Schema } from "./contract.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "./generated.ts";

describe("generated event ledger V2 contract", () => {
  test("keeps the checked-in JSON Schema and digest synchronized", () => {
    const schemaPath = resolve(import.meta.dir, "../../../../schemas/event-v2.schema.json");
    const checkedIn = JSON.parse(readFileSync(schemaPath, "utf8"));
    expect(canonicalJsonV2(checkedIn)).toBe(canonicalJsonV2(EventV2Schema));
    const digest = `sha256:${createHash("sha256")
      .update(canonicalJsonV2(EventV2Schema))
      .digest("hex")}`;
    expect(EVENT_V2_SCHEMA_DIGEST as string).toBe(digest);
  });
});
