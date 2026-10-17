import type { Command } from "commander";
import type { EmitContext } from "../commander.ts";
import type { HarneryInboxService } from "../core/inbox/service.ts";
import { watchInbox } from "../core/inbox/watcher.ts";

export function registerInboxCommand(
  program: Command,
  emit: EmitContext,
  service?: HarneryInboxService,
  defaultRecipient?: () => string,
): void {
  const inbox = program.command("inbox").description("Inspect private coordination inbox state");
  inbox
    .command("list [recipient]")
    .option("--json", "Emit stable JSON")
    .action((recipient: string | undefined, options: { json?: boolean }) => {
      run(emit, () => {
        recipient = requireRecipient(recipient, defaultRecipient);
        const rows = requireInboxService(service)
          .pending(recipient)
          .map((record) => ({
            message_id: record.message_id,
            sender_instance_id: record.sender_instance_id,
            sender_display_name: record.sender_display_name,
            created_at: record.created_at,
            body_bytes: record.body_bytes,
            body: record.body,
            state: "pending",
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
  inbox
    .command("watch [recipient]")
    .description("Surface pending messages for this instance; poll history until timeout")
    .option("--timeout <seconds>", "Stop after this many seconds", "60")
    .option("--json", "Emit one JSON record per surfaced message")
    .action(async (recipient: string | undefined, options: { json?: boolean; timeout: string }) => {
      let controller: AbortController | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const instanceId = requireRecipient(recipient, defaultRecipient);
        const inboxService = requireInboxService(service);
        const seconds = Number(options.timeout);
        if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw new Error("--timeout must be greater than 0 and at most 3600 seconds");
        controller = new AbortController();
        timer = setTimeout(() => controller!.abort(), seconds * 1000);
        if (options.json) emit.config({ format: "json" });
        for await (const message of watchInbox(inboxService, instanceId, { signal: controller.signal })) {
          const row = { ...message, state: "surfaced" };
          if (options.json) emit.data(row);
          else emit.rows([row]);
          // An output error leaves this ID pending for prompt recovery.
          await new Promise<void>((resolve, reject) => process.stdout.write("", (error) => error ? reject(error) : resolve()));
          inboxService.acknowledgeSurface(instanceId, [message.message_id]);
        }
      } catch (error) {
        emit.error({ code: "inbox_failed", message: error instanceof Error ? error.message : String(error) });
        emit.setExitCode(1);
      } finally {
        if (timer) clearTimeout(timer);
        controller?.abort();
      }
    });
}

function requireRecipient(recipient: string | undefined, fallback?: () => string): string {
  const resolved = recipient ?? fallback?.();
  if (!resolved) throw new Error("recipient instance is required outside an agent session");
  return resolved;
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
