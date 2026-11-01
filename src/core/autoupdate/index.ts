export {
  AUTOUPDATE_CHILD_ENV,
  type AutoUpdateDeps,
  type AutoUpdateStatus,
  autoUpdateStatus,
  autoUpdateTick,
  checkForUpdate,
  harnCliEntry,
  isHookConfigPath,
  isInstructionPath,
  parseNoticeLines,
  type RunAutoUpdateOptions,
  type RunAutoUpdateResult,
  runAutoUpdate,
  type StepRunner,
  type StepRunResult,
} from "./engine.ts";
export { expandWatchPath, fingerprint, fingerprintLines } from "./fingerprint.ts";
export type { GitResult, GitRunner, Upstream } from "./git.ts";
export {
  addNotice,
  autoUpdateLogPath,
  autoUpdateStatePath,
  type LockInspection,
  type LockOwner,
  pendingNotices,
  readAutoUpdateState,
} from "./state.ts";
export * from "./types.ts";
