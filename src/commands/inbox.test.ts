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

  test("watch emits back-to-back arrivals before acknowledging their exact IDs", async () => {
    const service = fixtureService();
    const send = (body: string) =>
      service.send({
        sender_instance_id: "sender",
        sender_display_name: "Sender",
        recipient_instance_id: "recipient",
        recipient_display_name: "Recipient",
        body,
      });
    send("first");
    const output = capture();
    // The second message arrives as soon as the first is emitted, so it is
    // waiting for the watcher's next poll (every 250 ms) with no timer race.
    // The window leaves several polls of margin on a loaded machine.
    const emitData = output.emit.data;
    let sentSecond = false;
    output.emit.data = (row) => {
      emitData(row);
      if (!sentSecond) {
        sentSecond = true;
        send("second");
      }
    };
    const program = new Command();
    registerInboxCommand(program, output.emit, service, () => "recipient");
    await program.parseAsync(["inbox", "watch", "--timeout", "1.5", "--json"], { from: "user" });
    expect(output.data).toMatchObject([
      { body: "first", state: "surfaced" },
      { body: "second", state: "surfaced" },
    ]);
    expect(service.pending("recipient")).toEqual([]);
    expect(service.records("recipient").filter(({ kind }) => kind === "surfaced")).toHaveLength(2);
  });

  test("watch output failure leaves the message pending for a native prompt", async () => {
    const service = fixtureService();
    service.send({
      sender_instance_id: "sender",
      sender_display_name: "Sender",
      recipient_instance_id: "recipient",
      recipient_display_name: "Recipient",
      body: "recover this",
    });
    const output = capture();
    output.emit.data = () => {
      throw new Error("output failed");
    };
    const program = new Command();
    registerInboxCommand(program, output.emit, service);
    await program.parseAsync(["inbox", "watch", "recipient", "--timeout", "0.05", "--json"], {
      from: "user",
    });
    expect(output.exits).toEqual([1]);
    expect(service.pending("recipient").map(({ body }) => body)).toEqual(["recover this"]);
    expect(service.records("recipient").map(({ kind }) => kind)).toEqual(["message"]);
  });
});

export function fixtureService(): HarneryInboxService {
  const root = mkdtempSync(join(tmpdir(), "harnery-inbox-command-"));
  roots.push(root);
  let sequence = 0;
  return new HarneryInboxService({
    coord_root: root,
    limits: limits(),
    id: () => `fixture-${++sequence}`,
  });
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
