import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import { HarneryConversationCatalog } from "../core/conversations/catalog.ts";
import type { HarneryConversationProvider } from "../core/conversations/contract.ts";
import { registerConversationsCommand } from "./conversations.ts";

describe("conversations command", () => {
  test("lists, queries, and builds explicit untrusted context packs", async () => {
    const output = capture();
    const program = new Command();
    registerConversationsCommand(
      program,
      output.emit,
      new HarneryConversationCatalog([provider()]),
      { project_scope_id: "project-a" },
    );
    await program.parseAsync(["conversations", "query", "--text", "requirement", "--json"], {
      from: "user",
    });
    expect(output.data[0]).toMatchObject({
      schema: "harnery.conversation-query/v1",
      hits: [{ citation: { native_record_id: "record-a" } }],
    });
    await program.parseAsync(["conversations", "context", "--record", "cr_missing", "--json"], {
      from: "user",
    });
    expect(output.data[1]).toMatchObject({
      schema: "harnery.conversation-context-pack/v1",
      boundary: "untrusted-historical-data",
      automatic_injection: false,
    });
  });

  test("refuses cross-project reads and keeps purge execution disabled", async () => {
    const output = capture();
    const program = new Command();
    registerConversationsCommand(
      program,
      output.emit,
      new HarneryConversationCatalog([provider()]),
      { project_scope_id: "project-a" },
    );
    await program.parseAsync(["conversations", "query", "--project", "project-b"], {
      from: "user",
    });
    expect(output.errors).toContainEqual({
      code: "conversation_command_failed",
      message: "cross-project conversation access denied",
    });
    await program.parseAsync(["conversations", "purge", "--json"], { from: "user" });
    const transaction = (output.data[0] as { transaction_id: string }).transaction_id;
    await program.parseAsync(
      ["conversations", "purge", "--transaction", transaction, "--yes", "--json"],
      { from: "user" },
    );
    expect(output.data[1]).toMatchObject({ accepted: false, reason_code: "execution_disabled" });
  });
});

function provider(): HarneryConversationProvider {
  return {
    capabilities: {
      provider_id: "fixture",
      roles: ["user", "assistant"],
      can_list: true,
      can_stream_source: true,
      can_replay_archive: true,
      default_completeness: "complete",
      default_omissions: [],
      retention_behavior: "fixture",
    },
    async list(projectScopeId) {
      return [
        {
          provider_id: "fixture",
          project_scope_id: projectScopeId,
          conversation_id: "conversation-a",
          snapshot_id: "snapshot-a",
          completeness: "complete",
          omissions: [],
        },
      ];
    },
    async snapshot(projectScopeId, conversationId) {
      return {
        snapshot_id: "snapshot-a",
        provider_id: "fixture",
        project_scope_id: projectScopeId,
        conversation_id: conversationId,
        observed_at: "2026-08-29T12:00:00.000Z",
        completeness: "complete",
        omissions: [],
      };
    },
    async *stream() {
      yield {
        native_conversation_id: "native-a",
        native_record_id: "record-a",
        role: "assistant",
        occurred_at: "2026-08-29T11:00:00.000Z",
        content: "earlier requirement",
      };
    },
  };
}

function capture(): {
  emit: EmitContext;
  data: unknown[];
  errors: unknown[];
} {
  const data: unknown[] = [];
  const errors: unknown[] = [];
  return {
    emit: {
      config: () => {},
      data: (value) => data.push(value),
      rows: () => {},
      text: () => {},
      file: () => {},
      error: (value) => errors.push(value),
      log: () => {},
      setExitCode: () => {},
    },
    data,
    errors,
  };
}
