import type { HarneryInboxMessageRecordV1 } from "./contract.ts";
import type { HarneryInboxService } from "./service.ts";

export async function* watchInbox(
  service: HarneryInboxService,
  recipientInstanceId: string,
  options: { signal: AbortSignal; poll_ms?: number },
): AsyncGenerator<HarneryInboxMessageRecordV1> {
  const seen = new Set<string>();
  while (!options.signal.aborted) {
    try {
      for (const message of service.pending(recipientInstanceId)) {
        if (seen.has(message.message_id)) continue;
        seen.add(message.message_id);
        yield message;
      }
    } catch {
      // A transient missing or incomplete source is retried; no cursor is advanced.
    }
    await delay(options.poll_ms ?? 250, options.signal);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
