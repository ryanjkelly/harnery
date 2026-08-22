import type { CodecPanelScene, CodecSemanticChannel } from "./contracts";

export type {
  CodecSemanticChannel,
  CodecSemanticPhase,
  CodecSemanticPresented,
  CodecSemanticReaderOutcome,
  CodecSemanticState,
  CodecSemanticTag,
} from "./contracts";

export function codecSemantic(panel: CodecPanelScene): CodecSemanticChannel | undefined {
  return panel.semantic;
}

export function setCodecSemantic(panel: CodecPanelScene, semantic: CodecSemanticChannel): void {
  panel.semantic = semantic;
}

export function stripCodecSemantic(panel: CodecPanelScene): CodecPanelScene {
  const { semantic: _semantic, ...withoutSemantic } = panel;
  return withoutSemantic;
}
