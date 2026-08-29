import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarneryInboxLimits } from "./contract.ts";
import { planInboxCompaction } from "./lifecycle.ts";
import { HarneryInboxService } from "./service.ts";
import { watchInbox } from "./watcher.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coordination inbox", () => {
  test("rejects capacity before append and preserves pending history", () => {
    const service = inbox({ max_pending_count: 2 });
    service.send(message("one"));
    service.send(message("two"));
    expect(() => service.send(message("three"))).toThrow("pending_count_limit");
    expect(service.pending("recipient").map(({ body }) => body)).toEqual(["one", "two"]);
    expect(service.status("recipient")).toMatchObject({
      pending_count: 2,
      pressure: "exhausted",
    });
  });

  test("surfaces oldest fitting records and a crash repeats without dropping", async () => {
    const service = inbox();
    service.send(message("one"));
    service.send(message("two"));
    await expect(
      service.surface("recipient", () => {
        throw new Error("prompt crash");
      }),
    ).rejects.toThrow("prompt crash");
    expect(service.pending("recipient")).toHaveLength(2);
    const emitted: string[] = [];
    const result = await service.surface(
      "recipient",
      (records) => {
        emitted.push(...records.map(({ body }) => body));
      },
      { max_count: 1, max_bytes: 100, max_tokens: 100 },
    );
    expect(emitted).toEqual(["one"]);
    expect(result).toMatchObject({
      remaining_pending_count: 1,
      repeated_after_crash_possible: true,
    });
  });

  test("plans compaction only after surfaced and terminal grace", async () => {
    let clock = new Date("2026-08-29T12:00:00.000Z");
    const service = inbox({}, () => clock);
    service.send(message("one"));
    await service.surface("recipient", () => {});
    clock = new Date("2026-08-29T12:00:02.000Z");
    const records = service.records("recipient");
    expect(
      planInboxCompaction({
        recipient_instance_id: "recipient",
        records,
        lifecycle: "active",
        now: clock,
        limits: limits(),
      }),
    ).toMatchObject({ action: "compact-surfaced", remove_record_count: 2, dry_run: true });
    expect(
      planInboxCompaction({
        recipient_instance_id: "recipient",
        records,
        lifecycle: "terminal",
        terminal_at: "2026-08-29T12:00:01.500Z",
        now: clock,
        limits: limits(),
      }),
    ).toMatchObject({ action: "none", reason_code: "terminal_grace" });
  });

  test("watcher recovers when the recipient history appears later", async () => {
    const service = inbox();
    const controller = new AbortController();
    const watcher = watchInbox(service, "recipient", { signal: controller.signal, poll_ms: 5 });
    const next = watcher.next();
    await Bun.sleep(10);
    service.send(message("later"));
    const observed = await next;
    controller.abort();
    expect(observed.value?.body).toBe("later");
  });
});

function inbox(overrides: Partial<HarneryInboxLimits> = {}, now?: () => Date) {
  return new HarneryInboxService({
    coord_root: fixture(),
    limits: limits(overrides),
    now,
    id: (() => {
      let sequence = 0;
      return () => String(++sequence);
    })(),
  });
}

function limits(overrides: Partial<HarneryInboxLimits> = {}): HarneryInboxLimits {
  return {
    max_message_body_bytes: 256,
    max_pending_count: 10,
    max_pending_bytes: 1_024,
    max_history_bytes: 16_384,
    max_history_records: 100,
    warning_pressure_ratio: 0.8,
    max_surface_count: 4,
    max_surface_bytes: 512,
    max_surface_tokens: 128,
    surfaced_grace_ms: 1_000,
    terminal_grace_ms: 5_000,
    ...overrides,
  };
}

function message(body: string) {
  return {
    sender_instance_id: "sender",
    sender_display_name: "Sender",
    recipient_instance_id: "recipient",
    recipient_display_name: "Recipient",
    body,
  };
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-inbox-"));
  roots.push(root);
  return root;
}
