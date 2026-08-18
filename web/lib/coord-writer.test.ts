import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  endSession,
  pingAgent,
  releaseClaim,
  resolveOperatorMutationOwner,
  safeOwnerId,
} from "./coord-writer";

describe("web coordination writer instance IDs", () => {
  test("rejects path traversal at every mutation boundary", async () => {
    const attack = "../../outside";
    expect(safeOwnerId(attack)).toBe(false);
    expect(await releaseClaim(attack, "src/index.ts")).toMatchObject({
      ok: false,
      error: "invalid instance_id",
    });
    expect(pingAgent(attack, "hello")).toMatchObject({
      ok: false,
      error: "invalid instance_id",
    });
    expect(await endSession(attack)).toMatchObject({ ok: false, error: "invalid instance_id" });
  });

  test("preserves a canonical owner when no validated native cache alias exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-operator-owner-"));
    try {
      expect(resolveOperatorMutationOwner("inst_fixture-owner", root)).toBe("inst_fixture-owner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("maps a canonical owner through a generation-bound native cache alias", () => {
    const root = mkdtempSync(path.join(tmpdir(), "harnery-operator-owner-"));
    try {
      const active = path.join(root, ".harnery", "active");
      mkdirSync(active, { recursive: true });
      writeFileSync(
        path.join(active, "fixture-owner.json"),
        JSON.stringify({
          schema_version: 2,
          instance_id: "fixture-owner",
          v3_instance_id: "inst_fixture-owner",
          v3_generation_id: "gen_fixture",
        }),
      );
      expect(resolveOperatorMutationOwner("inst_fixture-owner", root)).toBe("fixture-owner");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
