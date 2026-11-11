import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../../tests/helpers/event-v3-runtime.ts";
import {
  admitWaitingSubjectRowsV3,
  queueWaitingSubjectRowsV3,
} from "../../../../tests/helpers/event-v3-waiting.ts";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import type { EventV3 } from "../../events/v3/contract.ts";
import { readCoordinationViewV3 } from "../../events/v3/coordination-view.ts";
import { readLedgerV3 } from "../../events/v3/reader.ts";
import { readLiveCoordinationRow } from "../state/live-coordination-view.ts";
import { evaluateClaim } from "./claim-conflict.ts";

let root: string;

beforeEach(() => {
  root = join(tmpdir(), `harnery-claim-v3-${process.pid}-${crypto.randomUUID()}`);
  initializeV3Fixture(root);
});

afterEach(() => removeDir(root));

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

  test("a committed-clean peer claim is released citing its acquisition", () => {
    gitInit(root);
    commitFile(root, "docs/shared.md");
    seedV3Session(root, "self", { name: "Maya" });
    seedV3Session(root, "peer", { name: "Greta", claims: ["docs/shared.md"] });
    const acquisition = claimEvents("acquired").at(-1)!;

    expect(verdict("docs/shared.md")).toMatchObject({ allow: true, rule: "claim.pass" });
    const release = claimEvents("released").at(-1)!;
    expect(release.payload.subject_instance_id).toBe("inst_peer");
    expect((release.links as { caused_by: string[] }).caused_by).toContain(acquisition.event_id);
    expect(readCoordinationViewV3(root).diagnostics).toEqual([]);
  });

  test("a committed-clean peer claim stays held while the peer has waiting rows", () => {
    gitInit(root);
    commitFile(root, "docs/shared.md");
    seedV3Session(root, "self", { name: "Maya" });
    seedV3Session(root, "peer", { name: "Greta", claims: ["docs/shared.md"] });
    const rows = queueWaitingSubjectRowsV3(root, "codex", "peer");

    const held = verdict("docs/shared.md");
    expect(held).toMatchObject({ allow: false, rule: "claim.authority_unavailable" });
    expect(held.reason).toContain("generation_rows_waiting");
    expect(claimEvents("released")).toEqual([]);

    admitWaitingSubjectRowsV3(root, rows);
    expect(verdict("docs/shared.md")).toMatchObject({ allow: true, rule: "claim.pass" });
    expect(claimEvents("released")).toHaveLength(1);
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
  });

  test("a Claude Code session with no open turn still acquires its claim", () => {
    // A turn started by a background-task notification may have no prompt
    // hook; claims attach to the session span and must not need a turn.
    seedV3Session(root, "self", { name: "Maya", adapter: "claude-code" });
    expect(verdict("docs/x.md")).toMatchObject({ allow: true, rule: "claim.pass" });
  });

  test("a ledger refusal names its reason instead of a generic authority error", () => {
    const result = verdict("docs/x.md");
    expect(result).toMatchObject({ allow: false, rule: "claim.authority_unavailable" });
    expect(result.reason).toMatch(/refused the claim \(.+\)/);
    expect(result.reason).not.toContain("V3 authority is unavailable");
    expect(result.reason).toContain("agents health");
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

function claimEvents(operation: "acquired" | "released") {
  return readLedgerV3(root)
    .events.map(({ event }) => event)
    .filter(
      (event): event is Extract<EventV3, { event_type: "coord.claim_changed" }> =>
        event.event_type === "coord.claim_changed" && event.payload.operation === operation,
    );
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
