/**
 * The shape every coordination rule returns.
 *
 * Declared here once. The claim-conflict and stop-hook rules each carried a
 * byte-identical private copy, which is how two rules drift into disagreeing
 * about what a verdict is.
 */
export type VerdictResult = {
  allow: boolean;
  exit_code: 0 | 2;
  rule: string;
  reason?: string;
};
