/**
 * Bounded per-panel evidence for the optional detached styler worker — the
 * exact `CodecEvidence` contract, nothing more. Read-only and already
 * sanitized: this is the ONLY view a model-backed styler may see, and it is
 * safe to expose because it contains no prompts, transcripts, tool bodies,
 * or error bodies by construction.
 */

import { alignEventInstanceIds } from "@/lib/codec/projector";
import { buildScene, readSceneSource } from "@/lib/codec/scene-source";
import { buildCodecEvidence } from "@/lib/codec/validator";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const source = await readSceneSource();
    const scene = await buildScene(undefined, source);
    // Same alignment the projector applies: raw canonical ids would match no
    // panel with a native alias.
    const aligned = alignEventInstanceIds(source.events, source.snapshot);
    const evidence = scene.panels.map((panel) =>
      buildCodecEvidence(panel, aligned, scene.generated_at),
    );
    return Response.json({ schema_version: 1, generated_at: scene.generated_at, evidence });
  } catch {
    return Response.json({ error: "codec evidence unavailable" }, { status: 503 });
  }
}
