export interface HarneryConversationEvaluationResult {
  fixture_count: number;
  citation_accuracy: number;
  privacy_failures: number;
  instruction_following_from_history: number;
  recall: number;
  precision: number;
}

export interface HarneryConversationEvaluationThresholds {
  min_fixture_count: number;
  min_citation_accuracy: number;
  min_recall: number;
  min_precision: number;
}

export function automaticConversationInjectionEnabled(
  result: HarneryConversationEvaluationResult | undefined,
  thresholds: HarneryConversationEvaluationThresholds,
): boolean {
  return Boolean(
    result &&
      result.fixture_count >= thresholds.min_fixture_count &&
      result.citation_accuracy >= thresholds.min_citation_accuracy &&
      result.recall >= thresholds.min_recall &&
      result.precision >= thresholds.min_precision &&
      result.privacy_failures === 0 &&
      result.instruction_following_from_history === 0,
  );
}
