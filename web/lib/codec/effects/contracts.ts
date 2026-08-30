import type { CodecScene } from "../contracts";

export const CODEC_EFFECT_KINDS = ["ping", "energy", "power-up", "healing"] as const;

export type CodecEffectKind = (typeof CODEC_EFFECT_KINDS)[number];
export type CodecEffectPriority = 1 | 2 | 3;

/** A presentation-only request. Effect ids are deterministic so repeated
 * snapshots cannot replay the same moment. */
export interface CodecEffectCue {
  id: string;
  kind: CodecEffectKind;
  targetInstanceId: string;
  sourceInstanceId?: string;
  priority: CodecEffectPriority;
}

export interface CodecEffectPreview {
  sequence: number;
  kind: CodecEffectKind;
  targetInstanceId: string;
  sourceInstanceId?: string;
}

export interface CodecEffectEndpoint {
  kind: CodecEffectKind;
  role: "source" | "target";
  phase: "charge" | "incoming" | "impact";
  label: string;
  peerName?: string;
}

export type CodecEffectEndpointMap = Record<string, CodecEffectEndpoint>;

export interface CodecEffectRuntimeHandle {
  play(cue: CodecEffectCue, scene: CodecScene): boolean;
  playMany(cues: readonly CodecEffectCue[], scene: CodecScene): number;
  cancelAll(): void;
}
