import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { HarneryInboxLimits } from "../core/inbox/contract.ts";
import { HarneryInboxService } from "../core/inbox/service.ts";
import { registerInboxCommand } from "./inbox.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("inbox command", () => {
  test("lists pending bodies only on the explicit private inbox surface", async () => {
    const service = fixtureService();
    service.send({
      sender_instance_id: "sender",
      sender_display_name: "Sender",
      recipient_instance_id: "recipient",
      recipient_display_name: "Recipient",
      body: "private body",
    });
    const output = capture();
    const program = new Command();
    registerInboxCommand(program, output.emit, service);
    await program.parseAsync(["inbox", "list", "recipient", "--json"], { from: "user" });
    expect(output.data[0]).toMatchObject({
      schema: "harnery.inbox-list/v1",
      rows: [{ body: "private body", body_bytes: 12 }],
    });
  });
});

export function fixtureService(): HarneryInboxService {
  const root = mkdtempSync(join(tmpdir(), "harnery-inbox-command-"));
  roots.push(root);
  return new HarneryInboxService({ coord_root: root, limits: limits(), id: () => "fixture" });
}

function limits(): HarneryInboxLimits {
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
  };
}

export function capture(): {
  emit: EmitContext;
  data: unknown[];
  rows: Record<string, unknown>[][];
  errors: unknown[];
  exits: number[];
} {
  const data: unknown[] = [];
  const rows: Record<string, unknown>[][] = [];
  const errors: unknown[] = [];
  const exits: number[] = [];
  return {
    emit: {
      config: () => {},
      data: (value) => data.push(value),
      rows: (value) => rows.push(value),
      text: () => {},
      file: () => {},
      error: (value) => errors.push(value),
      log: () => {},
      setExitCode: (value) => exits.push(value),
    },
    data,
    rows,
    errors,
    exits,
  };
}
