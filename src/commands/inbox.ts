import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { HarneryInboxService } from "../core/inbox/service.ts";

export function registerInboxCommand(
  program: Command,
  emit: EmitContext,
  service?: HarneryInboxService,
): void {
  const inbox = program.command("inbox").description("Inspect private coordination inbox state");
  inbox
    .command("list <recipient>")
    .option("--json", "Emit stable JSON")
    .action((recipient: string, options: { json?: boolean }) => {
      run(emit, () => {
        const rows = requireInboxService(service)
          .pending(recipient)
          .map((record) => ({
          message_id: record.message_id,
          sender_instance_id: record.sender_instance_id,
          sender_display_name: record.sender_display_name,
          created_at: record.created_at,
          body_bytes: record.body_bytes,
          body: record.body,
          }));
        if (options.json) {
          emit.config({ format: "json" });
          emit.data({ schema: "harnery.inbox-list/v1", recipient_instance_id: recipient, rows });
        } else emit.rows(rows);
      });
    });
  inbox
    .command("status <recipient>")
    .option("--json", "Emit stable JSON")
    .action((recipient: string, options: { json?: boolean }) => {
      run(emit, () => {
        const status = requireInboxService(service).status(recipient);
        if (options.json) {
          emit.config({ format: "json" });
          emit.data(status);
        } else emit.rows([status as unknown as Record<string, unknown>]);
      });
    });
}

function requireInboxService(service?: HarneryInboxService): HarneryInboxService {
  if (!service) throw new Error("coordination inbox is not configured by this host");
  return service;
}

function run(emit: EmitContext, action: () => void): void {
  try {
    action();
  } catch (error) {
    emit.error({
      code: "inbox_failed",
      message: error instanceof Error ? error.message : String(error),
    });
    emit.setExitCode(1);
  }
}
