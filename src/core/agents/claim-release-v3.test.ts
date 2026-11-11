import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeV3Fixture, seedV3Session } from "../../../tests/helpers/event-v3-runtime.ts";
import {
  admitWaitingSubjectRowsV3,
  queueWaitingSubjectRowsV3,
} from "../../../tests/helpers/event-v3-waiting.ts";
import { removeDir } from "../../../tests/helpers/remove-dir.ts";
import type { EventV3 } from "../events/v3/contract.ts";
import { readCoordinationViewV3 } from "../events/v3/coordination-view.ts";
import { readLedgerV3 } from "../events/v3/reader.ts";
import { releaseClaimOnBehalfV3 } from "./claim-release-v3.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

describe("releaseClaimOnBehalfV3", () => {
  test("releases a claim the view shows held and cites its acquisition", () => {
    const root = fixtureRoot();
    seedV3Session(root, "lead", { name: "Lead" });
    seedV3Session(root, "member", { name: "Member", claims: ["docs/a.md"] });
    const acquisition = claimEvents(root, "acquired").at(-1)!;

    const released = releaseClaimOnBehalfV3(input(root, "docs/a.md"));
    expect(released).toMatchObject({ state: "released", acquired_event_id: acquisition.event_id });
    const release = claimEvents(root, "released").at(-1)!;
    expect((release.links as { caused_by: string[] }).caused_by).toContain(acquisition.event_id);
    expect(release.payload).toMatchObject({
      actor_instance_id: "inst_lead",
      subject_instance_id: "inst_member",
    });
    const view = readCoordinationViewV3(root);
    expect(view.diagnostics).toEqual([]);
    expect(view.instances.inst_member?.files_touched).toEqual([]);
  });

  test("skips a claim the view does not show held and writes nothing", () => {
    const root = fixtureRoot();
    seedV3Session(root, "lead", { name: "Lead" });
    seedV3Session(root, "member", { name: "Member", claims: ["docs/other.md"] });
    const before = ledgerIds(root);

    expect(releaseClaimOnBehalfV3(input(root, "docs/a.md"))).toEqual({
      state: "skipped",
      reason: "claim_not_held",
    });
    expect(ledgerIds(root)).toEqual(before);
  });

  test("skips while the holder's generation has waiting rows, then releases", () => {
    const root = fixtureRoot();
    seedV3Session(root, "lead", { name: "Lead" });
    seedV3Session(root, "member", { name: "Member", claims: ["docs/a.md"] });
    const rows = queueWaitingSubjectRowsV3(root, "codex", "member");
    const before = ledgerIds(root);

    expect(releaseClaimOnBehalfV3(input(root, "docs/a.md"))).toEqual({
      state: "skipped",
      reason: "generation_rows_waiting",
    });
    expect(ledgerIds(root)).toEqual(before);
    expect(readCoordinationViewV3(root).instances.inst_member?.files_touched).toEqual([
      "docs/a.md",
    ]);

    admitWaitingSubjectRowsV3(root, rows);
    expect(releaseClaimOnBehalfV3(input(root, "docs/a.md")).state).toBe("released");
    expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
    expect(readCoordinationViewV3(root).diagnostics).toEqual([]);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-claim-release-v3-"));
  roots.push(root);
  initializeV3Fixture(root);
  return root;
}

function input(root: string, path: string) {
  return {
    coordRoot: root,
    owner: "lead",
    subject: "member",
    nativeSessionId: "lead",
    adapter: "codex" as const,
    path,
  };
}

function claimEvents(root: string, operation: "acquired" | "released") {
  return readLedgerV3(root)
    .events.map(({ event }) => event)
    .filter(
      (event): event is Extract<EventV3, { event_type: "coord.claim_changed" }> =>
        event.event_type === "coord.claim_changed" && event.payload.operation === operation,
    );
}

function ledgerIds(root: string): string[] {
  return readLedgerV3(root).events.map(({ event }) => event.event_id);
}
