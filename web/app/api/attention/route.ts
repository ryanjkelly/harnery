import type { AttentionRouting } from "@/lib/attention-client";
import {
  acknowledgeAttention,
  claimAttention,
  observeAttention,
  validAttentionClient,
  validAttentionKey,
} from "@/lib/attention-routing";
import { coordRoot } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (
    !body ||
    Array.isArray(body) ||
    typeof body !== "object" ||
    !validAttentionClient(body.clientId)
  )
    return Response.json({ error: "invalid_attention_request" }, { status: 400 });
  const fields =
    body.operation === "observe"
      ? [
          "operation",
          "clientId",
          "eventKey",
          "visible",
          "focused",
          "interaction",
          "holdingGeneration",
        ]
      : body.operation === "claim"
        ? ["operation", "clientId", "eventKey", "generation"]
        : body.operation === "acknowledge"
          ? ["operation", "clientId", "eventKey"]
          : [];
  if (!fields.length || Object.keys(body).some((key) => !fields.includes(key)))
    return Response.json({ error: "invalid_attention_request" }, { status: 400 });
  try {
    let reply: AttentionRouting;
    if (body.operation === "observe") {
      if (
        !(body.eventKey === null || validAttentionKey(body.eventKey)) ||
        typeof body.visible !== "boolean" ||
        typeof body.focused !== "boolean" ||
        !Number.isSafeInteger(body.interaction) ||
        (body.interaction as number) < 0 ||
        !(body.holdingGeneration === null || validAttentionClient(body.holdingGeneration))
      )
        return Response.json({ error: "invalid_attention_observation" }, { status: 400 });
      reply = observeAttention(coordRoot(), {
        clientId: body.clientId,
        eventKey: body.eventKey,
        visible: body.visible,
        focused: body.focused,
        interaction: body.interaction as number,
        holdingGeneration: body.holdingGeneration,
      });
    } else {
      if (
        !validAttentionKey(body.eventKey) ||
        (body.operation === "claim" && !validAttentionClient(body.generation))
      )
        return Response.json({ error: "invalid_attention_event" }, { status: 400 });
      reply =
        body.operation === "claim"
          ? claimAttention(coordRoot(), body.eventKey, body.clientId, body.generation as string)
          : acknowledgeAttention(coordRoot(), body.eventKey, body.clientId);
    }
    return Response.json(reply, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "attention_routing_unavailable" }, { status: 503 });
  }
}
