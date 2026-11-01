import { coordEnv } from "../../lib/env.ts";
import type { AutoUpdateNotice, TickResult } from "../autoupdate/types.ts";
import { readAutoUpdateConfig } from "../config.ts";

/** Prefix on every self-update line injected into an agent's context. */
export const AUTOUPDATE_CUE_PREFIX = "Auto-update: ";

export interface AutoUpdateCueDeps {
  tick: (coordRoot: string) => TickResult;
  pendingNotices: (coordRoot: string, sessionKey: string) => AutoUpdateNotice[];
}

export interface AutoUpdateCueOptions {
  /**
   * Whether this hook will show context to the agent. When false, the tick
   * still runs but notices stay queued for a session that can read them.
   */
  deliver?: boolean;
  /** Test seam; production loads the engine lazily. */
  deps?: AutoUpdateCueDeps;
  /** Receives tick or delivery failures. The cue itself never throws. */
  onError?: (err: unknown, phase: "autoupdate-tick" | "autoupdate-notices") => void;
}

async function loadDeps(): Promise<AutoUpdateCueDeps> {
  const engine = await import("../autoupdate/index.ts");
  return {
    tick: (root) => engine.autoUpdateTick(root),
    pendingNotices: (root, key) => engine.pendingNotices(root, key),
  };
}

/**
 * Fire the activity-driven self-update check (ADR 0229) and collect the
 * notices this session has not seen yet, one context line each.
 *
 * Projects without an `autoUpdate` section pay one config stat and never load
 * the engine. With the section, the tick's hot path is one stamp stat; any
 * real work runs in a detached child, so the hook never waits on it. Fails
 * open: an error is reported through `onError` and the cue is empty.
 */
export async function autoUpdateHookContext(
  coordRoot: string,
  sessionKey: string,
  options: AutoUpdateCueOptions = {},
): Promise<string> {
  if (coordEnv("AUTOUPDATE_CHILD") === "1") return "";
  let deps: AutoUpdateCueDeps;
  try {
    if (!readAutoUpdateConfig(coordRoot)) return "";
    deps = options.deps ?? (await loadDeps());
  } catch (err) {
    options.onError?.(err, "autoupdate-tick");
    return "";
  }
  try {
    deps.tick(coordRoot);
  } catch (err) {
    options.onError?.(err, "autoupdate-tick");
  }
  if (options.deliver === false || !sessionKey) return "";
  try {
    return deps
      .pendingNotices(coordRoot, sessionKey)
      .map((notice) => `${AUTOUPDATE_CUE_PREFIX}${notice.text.trim()}`)
      .filter((line) => line.length > AUTOUPDATE_CUE_PREFIX.length)
      .join("\n");
  } catch (err) {
    options.onError?.(err, "autoupdate-notices");
    return "";
  }
}
