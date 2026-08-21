import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import { readLiveCoordinationRow } from "../state/live-coordination-view.ts";
import { evaluateClaim } from "./claim-conflict.ts";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `harnery-claim-v3-${process.pid}-${crypto.randomUUID()}`);
  initializeV3Fixture(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("evaluateClaim on canonical V3 authority", () => {
  test("a write acquires one idempotent canonical claim", () => {
    seedV3Session(root, "self", { name: "Maya" });
    expect(verdict("docs/x.md")).toMatchObject({ allow: true, rule: "claim.pass" });
    expect(verdict("docs/x.md")).toMatchObject({ allow: true, rule: "claim.pass" });
    expect(readLiveCoordinationRow(root, "self")?.files_touched).toEqual(["docs/x.md"]);
  });

  test("read mode never acquires a claim", () => {
    seedV3Session(root, "self", { name: "Maya" });
    expect(verdict("docs/x.md", "read")).toMatchObject({ allow: true, rule: "claim.pass" });
    expect(readLiveCoordinationRow(root, "self")?.files_touched).toEqual([]);
  });

  test("a live peer's canonical claim blocks the same path", () => {
    seedV3Session(root, "self", { name: "Maya" });
    seedV3Session(root, "peer", { name: "Adelaide", claims: ["docs/shared.md"] });
    const result = verdict("docs/shared.md");
    expect(result).toMatchObject({ allow: false, rule: "claim.authority_conflict" });
    expect(result.reason).toContain("agent-Adelaide");
  });

  test("unrelated peer work does not arm the ordering rule", () => {
    seedV3Session(root, "self", { name: "Maya", claims: ["src/z-higher.ts"] });
    seedV3Session(root, "peer", { name: "Greta", claims: ["zzz/unrelated.md"] });
    expect(verdict("src/a-lower.ts")).toMatchObject({ allow: true, rule: "claim.pass" });
  });

  test("contended higher claim blocks a new lower acquisition", () => {
    seedV3Session(root, "self", { name: "Maya", claims: ["src/z-higher.ts"] });
    seedV3Session(root, "peer", { name: "Greta", claims: ["src/z-higher.ts"] });
    expect(verdict("src/a-lower.ts")).toMatchObject({
      allow: false,
      rule: "claim.ordering_violation",
    });
  });

  test("a committed-clean higher claim is released before the lower claim is acquired", () => {
    gitInit(root);
    commitFile(root, "src/z-higher.ts");
    seedV3Session(root, "self", { name: "Maya", claims: ["src/z-higher.ts"] });
    seedV3Session(root, "peer", { name: "Greta", claims: ["src/z-higher.ts"] });
    expect(verdict("src/a-lower.ts")).toMatchObject({ allow: true, rule: "claim.pass" });
    expect(readLiveCoordinationRow(root, "self")?.files_touched).toEqual(["src/a-lower.ts"]);
  });
});

function verdict(path: string, mode: "read" | "write" = "write") {
  return evaluateClaim(root, {
    rule: "claim",
    instance_id: "self",
    session_id: "self",
    path,
    mode,
  });
}

function gitInit(dir: string): void {
  Bun.spawnSync(["git", "-C", dir, "init", "-q"]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.email", "test@example.invalid"]);
  Bun.spawnSync(["git", "-C", dir, "config", "user.name", "Test"]);
}

function commitFile(dir: string, relativePath: string): void {
  const absolutePath = join(dir, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, "fixture\n", "utf8");
  Bun.spawnSync(["git", "-C", dir, "add", relativePath]);
  Bun.spawnSync(["git", "-C", dir, "commit", "-q", "-m", "fixture"]);
}
