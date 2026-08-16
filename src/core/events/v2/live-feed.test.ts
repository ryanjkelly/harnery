import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventIdV2, generationIdV2 } from "./ids.ts";
import {
  EVENT_V2_LIVE_RELATIVE_ROOT,
  janitorLiveDisplayV2,
  readLiveDisplayV2,
  safeIntentDisplayV2,
  writeLiveDisplayV2,
} from "./live-feed.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V2 ephemeral live display", () => {
  test("stores only scrubbed bounded intent and policy-safe repository labels", () => {
    const root = temporaryRoot("event-v2-live");
    const generationId = generationIdV2();
    const row = writeLiveDisplayV2(
      root,
      {
        generation_id: generationId,
        event_id: eventIdV2(),
        executable: "rg",
        intent_display: "Inspect the adapter capability matrix",
        target_labels: ["harnery/src/core/events", "/home/ryan/secret", "../outside"],
      },
      () => new Date("2026-08-16T12:00:00.000Z"),
    );
    expect(row.intent_display).toBe("Inspect the adapter capability matrix");
    expect(row.target_labels).toEqual(["harnery/src/core/events"]);
    const path = join(root, EVENT_V2_LIVE_RELATIVE_ROOT, `${generationId}.ndjson`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, EVENT_V2_LIVE_RELATIVE_ROOT)).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8")).not.toContain("/home/ryan/secret");
  });

  test("omits uncertain prose and published secret shapes instead of partially rendering them", () => {
    for (const candidate of [
      "token=fixture-secret",
      "Use sk-abcdefghijklmnopqrstuvwxyz",
      "Email person@example.com",
      "Run deploy --token hidden",
      "Read /home/person/private.txt",
      `Inspect ${"a".repeat(40)}`,
    ]) {
      expect(safeIntentDisplayV2(candidate)).toBeUndefined();
    }
    const root = temporaryRoot("event-v2-live-omit");
    const generationId = generationIdV2();
    const row = writeLiveDisplayV2(root, {
      generation_id: generationId,
      event_id: eventIdV2(),
      executable: "deploy",
      intent_display: "token=fixture-secret",
    });
    expect(row.intent_display).toBeUndefined();
    expect(
      readFileSync(join(root, EVENT_V2_LIVE_RELATIVE_ROOT, `${generationId}.ndjson`), "utf8"),
    ).not.toContain("fixture-secret");
  });

  test("hides expired rows before janitor deletion and preserves a recently closed generation", () => {
    const root = temporaryRoot("event-v2-live-expiry");
    const generationId = generationIdV2();
    writeLiveDisplayV2(
      root,
      {
        generation_id: generationId,
        event_id: eventIdV2(),
        intent_display: "Review current tool activity",
      },
      () => new Date("2026-08-16T12:00:00.000Z"),
    );
    const path = join(root, EVENT_V2_LIVE_RELATIVE_ROOT, `${generationId}.ndjson`);
    expect(
      readLiveDisplayV2(root, generationId, () => new Date("2026-08-16T12:14:59.000Z")),
    ).toHaveLength(1);
    expect(existsSync(path)).toBe(true);
    expect(
      readLiveDisplayV2(root, generationId, () => new Date("2026-08-16T12:15:00.000Z")),
    ).toEqual([]);
    expect(existsSync(path)).toBe(true);
    expect(janitorLiveDisplayV2(root, () => new Date("2026-08-16T12:15:00.000Z"))).toEqual({
      scanned: 1,
      removed: 1,
      retained: 0,
    });
    expect(existsSync(path)).toBe(false);
  });

  test("rejects any TTL beyond the one-hour residue ceiling", () => {
    const root = temporaryRoot("event-v2-live-ttl");
    expect(() =>
      writeLiveDisplayV2(root, {
        generation_id: generationIdV2(),
        event_id: eventIdV2(),
        ttl_ms: 60 * 60 * 1_000 + 1,
      }),
    ).toThrow("between 1 ms and 1 hour");
  });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}
