/** Compare the browser's visible Codec cards with a fresh coordination read. */

import { type CodecCardCapture, compareCodecCards } from "@/lib/codec/card-audit";
import { readAgents } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

function validCapture(value: unknown): value is CodecCardCapture {
  if (!value || typeof value !== "object") return false;
  const capture = value as Partial<CodecCardCapture>;
  return (
    typeof capture.captured_at === "string" &&
    Number.isFinite(Date.parse(capture.captured_at)) &&
    typeof capture.scene_generated_at === "string" &&
    Array.isArray(capture.cards) &&
    capture.cards.length <= 200 &&
    capture.cards.every(
      (card) =>
        card &&
        typeof card.instance_id === "string" &&
        card.instance_id.length <= 160 &&
        typeof card.display_name === "string" &&
        card.display_name.length <= 160 &&
        (card.machine === undefined || typeof card.machine === "string") &&
        (card.task === null || (typeof card.task === "string" && card.task.length <= 512)) &&
        typeof card.presence === "string" &&
        typeof card.activity === "string" &&
        typeof card.lifecycle === "string" &&
        (card.ledger_state === null || typeof card.ledger_state === "string") &&
        typeof card.updated_at === "string",
    )
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const text = await request.text();
    if (text.length > 256_000)
      return Response.json({ error: "capture too large" }, { status: 413 });
    const capture: unknown = JSON.parse(text);
    if (!validCapture(capture)) {
      return Response.json({ error: "invalid card capture" }, { status: 400 });
    }
    return Response.json(compareCodecCards(capture, readAgents(), new Date().toISOString()), {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ error: "card comparison unavailable" }, { status: 503 });
  }
}
