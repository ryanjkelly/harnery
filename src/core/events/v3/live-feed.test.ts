import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_V3_LIVE_RELATIVE_ROOT,
  janitorLiveDisplayV3,
  listLiveDisplayV3,
  writeLiveDisplayV3,
} from "./live-feed.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const GEN_A = "gen_01a04d03-6f65-776d-bb23-5452d16b8980";
const GEN_B = "gen_01a04ce4-84ce-76e2-bef4-959ba97a824d";
const EVT_A = "evt_01a04d03-6f65-776d-bb23-5452d16b8981";
const EVT_B = "evt_01a04ce4-84ce-76e2-bef4-959ba97a824e";
const HOUR_MS = 60 * 60 * 1_000;

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-live-feed-"));
  roots.push(root);
  mkdirSync(join(root, EVENT_V3_LIVE_RELATIVE_ROOT), { recursive: true });
  return root;
}

describe("live-display expiry", () => {
  test("skips generation files whose last write is past the hard TTL", () => {
    const root = freshRoot();
    const t0 = new Date("2026-09-05T00:00:00.000Z");
    writeLiveDisplayV3(root, { generation_id: GEN_A, event_id: EVT_A }, () => t0);
    writeLiveDisplayV3(root, { generation_id: GEN_B, event_id: EVT_B }, () => t0);
    const stalePath = join(root, EVENT_V3_LIVE_RELATIVE_ROOT, `${GEN_A}.ndjson`);
    const twoHoursAgo = new Date(t0.getTime() - 2 * HOUR_MS);
    utimesSync(stalePath, twoHoursAgo, twoHoursAgo);

    const rows = listLiveDisplayV3(root, () => t0);
    expect(rows.map((row) => row.generation_id)).toEqual([GEN_B]);
  });

  test("the janitor removes hard-expired files and keeps live ones", () => {
    const root = freshRoot();
    const t0 = new Date("2026-09-05T00:00:00.000Z");
    writeLiveDisplayV3(root, { generation_id: GEN_A, event_id: EVT_A }, () => t0);
    writeLiveDisplayV3(root, { generation_id: GEN_B, event_id: EVT_B }, () => t0);
    const stalePath = join(root, EVENT_V3_LIVE_RELATIVE_ROOT, `${GEN_A}.ndjson`);
    const dayAgo = new Date(t0.getTime() - 24 * HOUR_MS);
    utimesSync(stalePath, dayAgo, dayAgo);

    const result = janitorLiveDisplayV3(root, () => t0);
    expect(result).toEqual({ scanned: 2, removed: 1, retained: 1 });
    expect(existsSync(stalePath)).toBe(false);
    expect(readdirSync(join(root, EVENT_V3_LIVE_RELATIVE_ROOT))).toEqual([`${GEN_B}.ndjson`]);
  });
});
