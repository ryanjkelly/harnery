import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_ADAPTER_IDS_V3 } from "./adapter-id.ts";
import { ensureEventLedgerV3 } from "./bootstrap.ts";
import {
  appendHookIntakeRecordV3,
  listHookIntakeGroupsV3,
  listHookIntakeRecordsV3,
} from "./producers/intake.ts";
import { readHookProducerStateV3, recordHookSignalV3 } from "./producers/recorder.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Event Ledger V3 adapter ids", () => {
  test("accepts every event adapter through intake and producer-state validation", () => {
    const root = temporaryRoot();
    ensureEventLedgerV3(root, "event-adapter-id-test");

    for (const adapter of EVENT_ADAPTER_IDS_V3) {
      const nativeSessionId = `${adapter}-session`;
      const result = recordHookSignalV3({
        coordRoot: root,
        mode: "active",
        signal: "session-start",
        payload: { raw: {}, session_id: nativeSessionId },
        adapter,
        instance_id: `inst_${adapter}`,
        producer_id: "prd_adapter-test",
        build_id: "build_adapter-test",
        platform: "linux",
      });
      expect(result.state).toBe("recorded");
      expect(readHookProducerStateV3(root, adapter, nativeSessionId)?.adapter).toBe(adapter);
    }
  });

  test("parses an intake record for every event adapter id", () => {
    const root = temporaryRoot();
    const sessionHash = `hid_${"a".repeat(64)}` as const;

    for (const adapter of EVENT_ADAPTER_IDS_V3) {
      appendHookIntakeRecordV3(root, sessionHash, {
        format: "harnery-v3-hook-intake",
        format_version: 1,
        mode: "active",
        signal: "session-start",
        payload: { raw: {}, session_id: `${adapter}-session` },
        adapter,
        instance_id: `inst_${adapter}`,
        producer_id: "prd_adapter-test",
        build_id: "build_adapter-test",
        platform: "linux",
      });
    }

    const groups = listHookIntakeGroupsV3(root);
    expect(groups.map((group) => group.adapter)).toEqual([...EVENT_ADAPTER_IDS_V3]);
    for (const group of groups) {
      expect(listHookIntakeRecordsV3(group.directory)[0]?.record?.adapter).toBe(group.adapter);
    }
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-event-adapters-"));
  roots.push(root);
  return root;
}
