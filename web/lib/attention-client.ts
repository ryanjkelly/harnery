/** Browser recipient protocol. Presence and grants never authorize work. */
export const ATTENTION_FRESH_MS = 6000;
export const ATTENTION_POLL_MS = 2000;
export const ATTENTION_ENGAGED_MS = 8000;

export type AttentionObservation = {
  clientId: string;
  eventKey: string | null;
  visible: boolean;
  focused: boolean;
  interaction: number;
  holdingGeneration: string | null;
};
export type AttentionMessage =
  | ({ operation: "observe" } & AttentionObservation)
  | { operation: "claim"; clientId: string; eventKey: string; generation: string }
  | { operation: "acknowledge"; clientId: string; eventKey: string };
export type AttentionRouting = {
  eventKey: string | null;
  recipientId: string | null;
  generation: string | null;
  state: "waiting" | "selected" | "claimed" | "acknowledged";
  granted: boolean;
  engaged: boolean;
  serverNow: number;
  expiresAt: number;
};
export type AttentionGrant = { eventKey: string; generation: string; engaged: boolean };

export async function attentionTransport(message: AttentionMessage): Promise<AttentionRouting> {
  const response = await fetch("/api/attention", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("attention_routing_unavailable");
  return response.json();
}

type ClientOptions = {
  clientId: string;
  transport?: (message: AttentionMessage) => Promise<AttentionRouting>;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
  onGrant: (grant: AttentionGrant) => void;
  onStop: () => void;
  onAcknowledged: (eventKey: string) => void;
};

function validRouting(value: AttentionRouting): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    (value.eventKey === null || typeof value.eventKey === "string") &&
    (value.recipientId === null || typeof value.recipientId === "string") &&
    (value.generation === null || typeof value.generation === "string") &&
    ["waiting", "selected", "claimed", "acknowledged"].includes(value.state) &&
    typeof value.granted === "boolean" &&
    typeof value.engaged === "boolean" &&
    typeof value.serverNow === "number" &&
    Number.isFinite(value.serverNow) &&
    value.serverNow >= 0 &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt >= value.serverNow
  );
}

/** One mounted provider; injected monotonic time and timers make races testable. */
export function createAttentionClient(options: ClientOptions) {
  const transport = options.transport ?? attentionTransport;
  const now = options.now ?? (() => performance.now());
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel =
    options.cancel ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let snapshot: Omit<AttentionObservation, "clientId" | "holdingGeneration"> = {
    eventKey: null,
    visible: false,
    focused: false,
    interaction: 0,
  };
  let generation: string | null = null;
  let epoch = 0;
  let timer: unknown;
  let disposed = false;
  let pending: Promise<void> | null = null;
  let dirty = false;

  const stop = () => {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    if (generation !== null) options.onStop();
    generation = null;
  };
  const accept = (
    reply: AttentionRouting,
    sentAt: number,
    expectedEpoch: number,
    claim = false,
  ) => {
    if (
      disposed ||
      epoch !== expectedEpoch ||
      !validRouting(reply) ||
      reply.eventKey !== snapshot.eventKey
    )
      return;
    if (reply.state === "acknowledged") {
      stop();
      if (reply.eventKey) options.onAcknowledged(reply.eventKey);
      return;
    }
    const remaining = reply.expiresAt - reply.serverNow - (now() - sentAt);
    if (
      reply.recipientId !== options.clientId ||
      !reply.generation ||
      !Number.isFinite(remaining) ||
      remaining <= 0 ||
      remaining > ATTENTION_FRESH_MS
    ) {
      stop();
      return;
    }
    if (claim && reply.granted && reply.state === "claimed") {
      stop();
      generation = reply.generation;
      options.onGrant({
        eventKey: reply.eventKey!,
        generation: reply.generation,
        engaged: reply.engaged,
      });
    }
    if (generation !== reply.generation) return;
    if (timer !== undefined) cancel(timer);
    timer = schedule(stop, remaining);
  };

  const pump = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) {
      dirty = true;
      return pending;
    }
    const expectedEpoch = epoch;
    const observed = { ...snapshot };
    const sentAt = now();
    pending = (async () => {
      try {
        const reply = await transport({
          operation: "observe",
          clientId: options.clientId,
          ...observed,
          holdingGeneration: generation,
        });
        if (
          disposed ||
          expectedEpoch !== epoch ||
          !validRouting(reply) ||
          reply.eventKey !== observed.eventKey
        )
          return;
        accept(reply, sentAt, expectedEpoch);
        if (
          observed.eventKey &&
          reply.state === "selected" &&
          reply.recipientId === options.clientId &&
          reply.generation
        ) {
          const claimSentAt = now();
          const claimed = await transport({
            operation: "claim",
            clientId: options.clientId,
            eventKey: observed.eventKey,
            generation: reply.generation,
          });
          if (claimed.generation !== reply.generation) return;
          accept(claimed, claimSentAt, expectedEpoch, true);
        }
      } catch {
        // Transport failure cannot extend an existing authorization's timer.
      }
    })().finally(() => {
      pending = null;
      if (dirty && !disposed) {
        dirty = false;
        void pump();
      }
    });
    return pending;
  };
  return {
    observe(next: typeof snapshot): Promise<void> {
      if (next.eventKey !== snapshot.eventKey) {
        epoch++;
        stop();
      }
      snapshot = { ...next };
      return pump();
    },
    async acknowledge(): Promise<void> {
      const key = snapshot.eventKey;
      epoch++;
      stop();
      // A click can happen before the initial event observation completes.
      // Publish it after that request so the server can validate the ack.
      try {
        await pending;
        if (!key || disposed || snapshot.eventKey !== key) return;
        await transport({
          operation: "observe",
          ...snapshot,
          eventKey: key,
          clientId: options.clientId,
          holdingGeneration: null,
        });
        await transport({ operation: "acknowledge", eventKey: key, clientId: options.clientId });
      } catch {
        /* The tab's local acknowledgment is retained if offline. */
      }
    },
    dispose(): void {
      disposed = true;
      epoch++;
      stop();
      // Sequence withdrawal after the last observation, so it cannot republish
      // a disposed event after the null observation reaches the server.
      void Promise.resolve(pending)
        .then(() =>
          transport({
            operation: "observe",
            clientId: options.clientId,
            ...snapshot,
            eventKey: null,
            holdingGeneration: null,
          }),
        )
        .catch(() => {});
    },
  };
}
