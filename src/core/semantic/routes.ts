import type { SemanticConfiguredModel, SemanticHarness } from "./contract.ts";

export interface SemanticReaderRoute {
  harness: SemanticHarness;
  binary: string;
  configured_model: SemanticConfiguredModel;
  invocation_model_id: string;
}

/** Pure route data shared by the adapters, CLI status, and read-only Codec path. */
export const SEMANTIC_READER_ROUTES: Record<SemanticHarness, SemanticReaderRoute> = {
  "claude-code": {
    harness: "claude-code",
    binary: "claude",
    configured_model: "haiku-4.5",
    invocation_model_id: "claude-haiku-4-5-20251001",
  },
  codex: {
    harness: "codex",
    binary: "codex",
    configured_model: "gpt-5.6-luna",
    invocation_model_id: "gpt-5.6-luna",
  },
  cursor: {
    harness: "cursor",
    binary: "cursor-agent",
    configured_model: "composer-2.5",
    invocation_model_id: "composer-2.5",
  },
};
