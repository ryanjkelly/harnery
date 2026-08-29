import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import { capture, fixtureService } from "./inbox.test.ts";
import { registerMessagesCommand } from "./messages.ts";

describe("messages command", () => {
  test("is dry-run by default and writes only with --yes", async () => {
    const service = fixtureService();
    const output = capture();
    const program = new Command();
    registerMessagesCommand(program, output.emit, service);
    const args = [
      "messages",
      "--from",
      "sender",
      "--from-name",
      "Sender",
      "--to",
      "recipient",
      "--to-name",
      "Recipient",
      "--body",
      "hello",
    ];
    await program.parseAsync(args, { from: "user" });
    expect(output.data[0]).toMatchObject({ state: "dry-run", writes: false });
    expect(service.pending("recipient")).toEqual([]);
    await program.parseAsync([...args, "--yes"], { from: "user" });
    expect(service.pending("recipient")).toHaveLength(1);
  });
});
