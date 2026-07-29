export {
  Browser,
  type BrowserOptions,
  type ConsoleEvent,
  type Diagnostics,
  type FailedRequest,
  type NavigateResult,
  type PageErrorEvent,
} from "./client.js";
export type {
  CheckRect,
  ContentAnnotationBox,
  ContentChecksRequest,
  ContentChecksResult,
  ContrastHit,
  ContrastResult,
  ImageHealthResult,
  ImageHit,
  PlaceholderHit,
  PlaceholderResult,
  TruncationHit,
  TruncationResult,
} from "./content-checks.js";
export {
  bandRects,
  type CritiqueFinding,
  type CritiqueProvider,
  type CritiqueResult,
  type CritiqueTile,
  DEFAULT_CRITIQUE_RUBRIC,
  normalizeFindings,
  runCritique,
} from "./critique.js";
export {
  captureDevOverlay,
  type DevOverlayError,
  type DevOverlayResult,
} from "./dev-overlay.js";
export type {
  AlignChild,
  AlignCluster,
  AlignResult,
  ClipIssue,
  ClipResult,
  CrowdPair,
  CrowdResult,
  GapCluster,
  GapPair,
  GapResult,
  LayoutAxis,
  LayoutElementMeasurement,
  LayoutExclusion,
  LayoutLintRequest,
  LayoutLintResult,
  LayoutOutcome,
  LayoutRect,
  OverlapIssue,
  OverlapResult,
} from "./geometry.js";
export { isWSL, wslHeadedLaunchArgs } from "./launch-args.js";
export type {
  OverflowElement,
  OverflowResult,
  WidthResult,
} from "./layout.js";
export type {
  RuntHit,
  RuntsResult,
} from "./runts.js";
export type {
  TargetSizeNode,
  TargetSizeOutcome,
  TargetSizeProfile,
  TargetSizeResult,
} from "./target-size.js";
export type {
  CheckVisibilityOptions,
  VisibilityResult,
  VisibilitySample,
} from "./visibility.js";
