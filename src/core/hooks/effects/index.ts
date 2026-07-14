/**
 * Non-coordination side effects fired from the normalized `agent-hook` handlers.
 *
 * These are DELIBERATELY outside the agent-coord path: sounds, scratch
 * lifecycle, session telemetry, presence detection. They used to live in
 * per-harness bash adapters. Per the directive ("use the normalized hooks; if
 * they aren't coordination, implement them outside of coordination") they move
 * here so the harness configs reference only `agent-hook`, while staying a
 * distinct concern from the coordination logic in cli.ts / agent-coord.
 *
 * Everything here is best-effort: it never throws and never blocks the hook on a
 * slow dependency (telemetry runs detached).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { applyDetection } from "../../../lib/presence.ts";

export type { CaptureContext } from "./image-capture.ts";
export { captureImages, imageJanitor } from "./image-capture.ts";

/**
 * Play a notification sound via the cross-platform utility
 * (afplay on macOS, powershell.exe on WSL). The
 * utility backgrounds the actual player, so this returns fast. Rate-limiting
 * lives in the utility, keyed on CLAUDE_SOUND_SESSION_ID + the per-event count.
 * Claude-Code-only today (Cursor has no sounds; Codex's never worked).
 */
export function playSound(
  repoRoot: string,
  soundEvent: string,
  sessionId: string,
  maxPlays = 0,
): void {
  try {
    const player = join(repoRoot, "scripts", "hooks", "play-sound.sh");
    if (!existsSync(player)) return;
    spawnSync("bash", [player, soundEvent, String(maxPlays)], {
      env: { ...process.env, CLAUDE_SOUND_SESSION_ID: sessionId },
      timeout: 4000,
      stdio: "ignore",
    });
  } catch {
    // best-effort
  }
}

/** Map an agent-hook CLI event name → sound, or null if the event has no sound. */
export function soundForEvent(eventName: string): { sound: string; maxPlays: number } | null {
  switch (eventName) {
    case "stop":
      return { sound: "stop", maxPlays: 0 };
    case "stop-failure":
      return { sound: "error", maxPlays: 0 };
    case "sub-agent-start":
      return { sound: "subagent-start", maxPlays: 3 };
    default:
      return null;
  }
}

function harnBin(repoRoot: string): string | null {
  const bin = join(repoRoot, "harnery", "bin", "harn");
  return existsSync(bin) ? bin : null;
}

/** Prune stale scratch archives + sweep orphans (global, fast). Fire-and-forget. */
export function scratchJanitor(repoRoot: string): void {
  try {
    const bin = harnBin(repoRoot);
    if (!bin) return;
    spawnSync("bash", [bin, "scratch", "janitor", "--quiet"], {
      env: { ...process.env, HARNERY_OUTPUT_SESSION_TEE: "0" },
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {
    // best-effort
  }
}

/**
 * Return the one-line scratch recovery cue for SessionStart, or "" if none.
 * The caller merges it into the session-start additionalContext (it used to be
 * a standalone additionalContext emission from the previous scratch-on-start adapter).
 */
export function scratchRecoveryCue(repoRoot: string): string {
  try {
    const bin = harnBin(repoRoot);
    if (!bin) return "";
    const r = spawnSync("bash", [bin, "scratch", "recovery-cue"], {
      env: { ...process.env, HARNERY_OUTPUT_SESSION_TEE: "0" },
      timeout: 5000,
      encoding: "utf8",
    });
    return (r.stdout ?? "").trim();
  } catch {
    return "";
  }
}

/** Archive the ending agent's scratchpad. Fire-and-forget. */
export function scratchArchive(repoRoot: string, owner: string): void {
  try {
    const bin = harnBin(repoRoot);
    if (!bin || !owner) return;
    spawnSync("bash", [bin, "scratch", "archive", "--owner", owner], {
      env: { ...process.env, HARNERY_OUTPUT_SESSION_TEE: "0" },
      timeout: 5000,
      stdio: "ignore",
    });
  } catch {
    // best-effort
  }
}

/**
 * Fire the optional host session-sync extension on turn stop / session end.
 * harnery core has no session-telemetry sink of its own; a host that wants one
 * drops an executable at
 * `scripts/hooks/harness/claude_code/extensions/session-sync.sh` under the coord
 * root, and core runs it detached + unref'd so a slow sink never blocks the
 * hook. `force` arrives as argv $1 ("1" on session end, "0" on turn stop) so the
 * host can rate-limit the stop path and force-flush on end. No-op when the
 * script is absent, so a plain public install spawns nothing. Mirrors
 * `runTurnSummary`'s extension-script pattern. Caller gates to the claude-code
 * harness.
 */
export function runSessionSyncExtension(repoRoot: string, force: boolean): void {
  try {
    const script = join(
      repoRoot,
      "scripts",
      "hooks",
      "harness",
      "claude_code",
      "extensions",
      "session-sync.sh",
    );
    if (!existsSync(script)) return;
    const child = spawn("bash", [script, force ? "1" : "0"], {
      env: { ...process.env, HARNERY_OUTPUT_SESSION_TEE: "0" },
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // best-effort
  }
}

/**
 * Fire the turn-summary extension (Haiku auto-summary of the turn → heartbeat
 * `turn_summary`). Detached + unref'd; it makes an Anthropic API call and must
 * never block the Stop hook. Claude-Code-only. The
 * script self-guards on ANTHROPIC_API_KEY / curl / jq / matching session.
 */
export function runTurnSummary(
  repoRoot: string,
  owner: string,
  sessionId: string,
  transcriptPath: string | undefined,
): void {
  try {
    if (!transcriptPath || !existsSync(transcriptPath)) return;
    const script = join(
      repoRoot,
      "scripts",
      "hooks",
      "harness",
      "claude_code",
      "extensions",
      "turn-summary.sh",
    );
    if (!existsSync(script)) return;
    const child = spawn("bash", [script, owner, sessionId, transcriptPath], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // best-effort
  }
}

/** Reset per-turn sound rate-limit counters at the start of a new turn. */
export function resetSoundCounters(sessionId: string): void {
  try {
    if (!sessionId) return;
    const dir = os.tmpdir();
    const prefix = `claude-sounds-${sessionId}-`;
    for (const f of readdirSync(dir)) {
      if (f.startsWith(prefix) && f.endsWith(".count")) {
        rmSync(join(dir, f), { force: true });
      }
    }
  } catch {
    // best-effort
  }
}

/**
 * Update the mobile-vs-office presence file from the user's prompt shape, using
 * harnery's own presence library in-process: no external script, no host-path
 * dependency. Claude-Code-only (the heuristic is tuned to CC's user-prompt
 * payload; Cursor/Codex don't surface comparable prompt text). Fire-and-forget.
 */
export function detectPresence(prompt: string): void {
  try {
    if (!prompt) return;
    applyDetection(prompt);
  } catch {
    // best-effort
  }
}
