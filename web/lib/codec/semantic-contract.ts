import type {
  SemanticAgentReadModelV1,
  SemanticPhase,
  SemanticTag,
} from "../../../src/core/semantic/contract";

import type { CodecPanelScene, Presented } from "./contracts";

export type CodecSemanticState = "current" | "stale" | "unavailable" | "invalid" | "deferred";

export interface CodecSemanticPresented<T> extends Presented<T> {
  basis: "model-synthesis" | "prediction";
}

export interface CodecSemanticChannel {
  state: CodecSemanticState;
  reader_outcome: SemanticAgentReadModelV1["reader_outcome"];
  reader: {
    harness: string;
    configured_model: string;
    resolved_model_id?: string;
    model_attestation?: "verified" | "requested-only";
  };
  evidence_digest: string;
  observed_through_event_id: string;
  observed_through_ts: string;
  generated_at: string;
  expires_at: string;
  headline?: CodecSemanticPresented<string>;
  summary?: CodecSemanticPresented<string>;
  phase?: CodecSemanticPresented<SemanticPhase>;
  purpose?: CodecSemanticPresented<string>;
  recent_result?: CodecSemanticPresented<string>;
  attention?: CodecSemanticPresented<string>;
  next_step?: CodecSemanticPresented<string>;
  tags?: CodecSemanticPresented<SemanticTag[]>;
  receipt?: {
    reason_code: string;
    eligible_after?: string;
  };
}

type SemanticPanel = CodecPanelScene & { semantic?: CodecSemanticChannel };

export function codecSemantic(panel: CodecPanelScene): CodecSemanticChannel | undefined {
  return (panel as SemanticPanel).semantic;
}

export function setCodecSemantic(panel: CodecPanelScene, semantic: CodecSemanticChannel): void {
  (panel as SemanticPanel).semantic = semantic;
}

export function stripCodecSemantic(panel: CodecPanelScene): CodecPanelScene {
  const { semantic: _semantic, ...withoutSemantic } = panel as SemanticPanel;
  return withoutSemantic;
}
