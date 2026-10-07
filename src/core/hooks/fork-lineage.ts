/**
 * Claude Code fork detection: decide whether a new main-session instance is a
 * branch of another session, and which one.
 *
 * Two shapes exist as of Claude Code 2.1.283 (verified 2026-10-07):
 *
 *   - CLI `--resume <id> --fork-session` fires SessionStart under the FORK's id
 *     with `source: "fork"`, before its transcript exists, and names no parent.
 *     The transcript later holds the parent's message uuids with every row's
 *     `sessionId` rewritten, so the parent is found by uuid containment
 *     (`detectForkParent`) once the transcript is on disk.
 *   - The desktop app's "Fork from here" copies the parent's rows into the
 *     fork's transcript with their original `sessionId`, so inherited rows
 *     name the parent directly (`detectInheritedSessionParent`).
 *
 * Inherited rows alone do not prove a fork: a continuation of a finished
 * session can carry them too. The parent's liveness separates the two. A
 * parent with an unended generation is still running (or resumable) and owns
 * its name, task, and claims, so the new instance is a fork. A finished
 * parent makes it a continuation, which keeps the generic notice.
 *
 * Everything here fails open: an unreadable transcript or an unknown layout
 * yields "not a fork", never an error.
 */

import { existsSync } from "node:fs";
import { readLiveCoordinationRow } from "../agents/state/live-coordination-view.ts";
import { detectForkParent, detectInheritedSessionParent } from "./resolve/transcript.ts";

export interface ForkDetection {
  fork: boolean;
  forkedFrom?: string;
  /** Detection had the evidence it needs; the tool-path heal can skip it. */
  checked: boolean;
}

/** Sources after which a brand-new instance cannot hold inherited history. */
const FRESH_SOURCES = new Set(["startup", "clear"]);

export function detectClaudeCodeFork(input: {
  coordRoot: string;
  transcriptPath: string | undefined;
  sessionId: string;
  source?: string;
  /** The instance was already recorded as a fork without a parent. */
  knownFork?: boolean;
  isLive?: (instanceId: string) => boolean;
}): ForkDetection {
  try {
    const declared = input.source === "fork" || input.knownFork === true;
    const transcriptReady = !!input.transcriptPath && existsSync(input.transcriptPath);
    const isLive =
      input.isLive ?? ((id: string) => readLiveCoordinationRow(input.coordRoot, id) !== null);

    const inherited = transcriptReady
      ? detectInheritedSessionParent(input.transcriptPath, input.sessionId)
      : undefined;
    if (inherited && inherited !== input.sessionId) {
      if (declared || isLive(inherited)) {
        return { fork: true, forkedFrom: inherited, checked: true };
      }
      return { fork: false, checked: true };
    }

    if (declared) {
      if (!transcriptReady) return { fork: true, checked: false };
      const parent = detectForkParent(input.transcriptPath, input.sessionId);
      return {
        fork: true,
        ...(parent && parent !== input.sessionId ? { forkedFrom: parent } : {}),
        checked: true,
      };
    }

    return {
      fork: false,
      checked: transcriptReady || FRESH_SOURCES.has(input.source ?? ""),
    };
  } catch {
    return { fork: false, checked: true };
  }
}
