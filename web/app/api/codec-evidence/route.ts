/**
 * Bounded per-panel evidence for the optional detached styler worker — the
 * exact `CodecEvidence` contract, nothing more. Read-only and already
 * sanitized: this is the ONLY view a model-backed styler may see, and it is
 * safe to expose because it contains no prompts, transcripts, tool bodies,
 * or error bodies by construction.
 */

import { alignEventInstanceIds } from "@/lib/codec/projector";
import { buildScene, readSanitizedTail } from "@/lib/codec/scene-source";
import { buildCodecEvidence } from "@/lib/codec/validator";
import { readAgents } from "@/lib/coord-reader";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const [scene, events] = [await buildScene(), await readSanitizedTail()];
    // Same alignment the projector applies: this route folds a second read of
    // the tail, and raw canonical ids would match no panel with a native alias.
    const aligned = alignEventInstanceIds(events, readAgents());
    const evidence = scene.panels.map((panel) =>
      buildCodecEvidence(panel, aligned, scene.generated_at),
    );
    return Response.json({ schema_version: 1, generated_at: scene.generated_at, evidence });
  } catch {
    return Response.json({ error: "codec evidence unavailable" }, { status: 503 });
  }
}
