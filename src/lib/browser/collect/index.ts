export {
  type CollectDriver,
  type CollectedItem,
  type CollectLimits,
  type CollectResult,
  type CollectRunOptions,
  type CollectStats,
  DEFAULT_COLLECT_LIMITS,
  type HarvestedItem,
  ItemStore,
  type PageMetrics,
  runCollect,
  type StopReason,
} from "./collector.ts";
export {
  type Extractor,
  type FieldSpec,
  parseExtractor,
  parseFieldSpec,
  RESERVED_FIELD_NAMES,
} from "./fields.ts";
export { createPageDriver, type PageDriverDeps } from "./page-driver.ts";
export {
  COLLECT_PRESETS,
  type CollectPreset,
  type CollectSpecOverrides,
  presetNames,
  type ResolvedCollectSpec,
  resolveCollectSpec,
} from "./presets.ts";
export {
  createRng,
  DEFAULT_SCROLL_PACING,
  PACING_LIMITS,
  parseProbability,
  parseRange,
  planScrollStep,
  type Range,
  type Rng,
  randomSeed,
  type ScrollPacing,
  type ScrollStepPlan,
  scrollPacingFromEnv,
  uniform,
  type WheelTick,
  wheelTicks,
} from "./scroll-plan.ts";
