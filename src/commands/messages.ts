import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { HarneryInboxService } from "../core/inbox/service.ts";

export function registerMessagesCommand(
  program: Command,
  emit: EmitContext,
  service?: HarneryInboxService,
): void {
  program
    .command("messages")
    .description("Queue a durable coordination message; dry-run unless --yes")
    .requiredOption("--from <instance>")
    .requiredOption("--from-name <name>")
    .requiredOption("--to <instance>")
    .requiredOption("--to-name <name>")
    .requiredOption("--body <text>")
    .option("--yes", "Append and sync the message")
    .option("--json", "Emit stable JSON")
    .action(
      (options: {
        from: string;
        fromName: string;
        to: string;
        toName: string;
        body: string;
        yes?: boolean;
        json?: boolean;
      }) => {
        try {
          const result = options.yes
            ? requireInboxService(service).send({
                sender_instance_id: options.from,
                sender_display_name: options.fromName,
                recipient_instance_id: options.to,
                recipient_display_name: options.toName,
                body: options.body,
              })
            : {
                state: "dry-run" as const,
                recipient_instance_id: options.to,
                body_bytes: Buffer.byteLength(options.body),
                writes: false,
              };
          if (options.json) emit.config({ format: "json" });
          emit.data({ schema: "harnery.message-send/v1", ...result });
        } catch (error) {
          emit.error({
            code: "message_send_failed",
            message: error instanceof Error ? error.message : String(error),
          });
          emit.setExitCode(1);
        }
      },
    );
}

function requireInboxService(service?: HarneryInboxService): HarneryInboxService {
  if (!service) throw new Error("coordination inbox is not configured by this host");
  return service;
}
