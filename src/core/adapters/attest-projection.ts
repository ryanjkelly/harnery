/**
 * Live probe for the `filesystemPolicyProjection` capability (ADR 0041).
 *
 * Every other attested dimension can be read off a single successful turn: the
 * result either carries a session id or it does not. Projection cannot. A
 * sandbox that is declared but not enforced looks exactly like a sandbox that is
 * enforced, because in both cases the CLI accepts the flag and exits zero. The
 * only way to tell them apart is to give a child something to write and look at
 * the filesystem afterwards.
 *
 * That introduces its own confound. If the treatment child never attempts the
 * write, the sentinel is absent for a reason that has nothing to do with the
 * sandbox, and absence would be read as enforcement. So the probe runs a control
 * first, under a mode that permits the write. Only a control that actually
 * produced its sentinel licenses any reading of the treatment run; otherwise the
 * probe reports inconclusive and records nothing, which is the same prerequisite
 * rule the main attestation applies to a failed turn.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnRequest, SpawnResult } from "../workflow/types.ts";
import type { Adapter } from "./types.ts";

/** Distinct names so a control artifact can never be mistaken for a treatment
 * one, even if a child writes both or the directory is reused. */
const CONTROL_SENTINEL = "harnery-projection-control.txt";
const TREATMENT_SENTINEL = "harnery-projection-treatment.txt";

/** A child needs a few turns to run a shell command and report back; one turn is
 * not enough to both act and answer. */
const PROJECTION_MAX_TURNS = 4;

export function projectionPrompt(sentinel: string): string {
  return `Create a file named ${sentinel} in the current directory containing the text ok. Then reply with the single word: done`;
}

export type ProjectionObservation = "supported" | "unsupported" | "inconclusive";

export interface ProjectionProbeResult {
  observation: ProjectionObservation;
  /** Why, in one line, suitable for an attestation note or a report row. */
  detail: string;
}

export interface ProjectionProbeOptions {
  timeoutMs: number;
  subscriptionOnly: boolean;
  /** Test seam. Defaults to the adapter's production spawner. */
  spawn?: (request: SpawnRequest) => Promise<SpawnResult>;
  /** Test seam. Defaults to a fresh directory under the OS temp root. */
  workdir?: string;
}

/**
 * Run the control/treatment pair and report what the filesystem showed.
 *
 * Returns `inconclusive` rather than throwing for every expected failure, so a
 * probe that cannot reach a verdict degrades into "nothing recorded" instead of
 * failing the whole attestation sweep.
 */
export async function probeFilesystemProjection(
  adapter: Adapter,
  opts: ProjectionProbeOptions,
): Promise<ProjectionProbeResult> {
  if (!adapter.profile.sandboxProjection) {
    // Nothing to observe: the adapter refuses a projection before launch, which
    // is a fact about our own code and is already covered by unit tests. Spending
    // a vendor turn here would attest nothing.
    return {
      observation: "inconclusive",
      detail: "the adapter declares no sandbox projection, so there is nothing to observe live",
    };
  }

  const spawn = opts.spawn ?? ((request: SpawnRequest) => adapter.spawn(request));
  const ownsWorkdir = !opts.workdir;
  const workdir = opts.workdir ?? mkdtempSync(join(tmpdir(), "harnery-projection-"));

  try {
    const control = await runTurn(spawn, workdir, CONTROL_SENTINEL, "workspace-write", opts);
    if (!control.ok) {
      return {
        observation: "inconclusive",
        detail: `the control turn did not complete (${control.detail})`,
      };
    }
    if (!existsSync(join(workdir, CONTROL_SENTINEL))) {
      return {
        observation: "inconclusive",
        detail:
          "the control child did not create its file even though writing was permitted, so an absent treatment file would prove nothing",
      };
    }

    const treatment = await runTurn(spawn, workdir, TREATMENT_SENTINEL, "read-only", opts);
    // A read-only child may well fail its turn: refusing the write is the point.
    // So unlike the control, a failed treatment turn is still evidence, and only
    // the filesystem decides.
    const wrote = existsSync(join(workdir, TREATMENT_SENTINEL));
    if (wrote) {
      return {
        observation: "unsupported",
        detail:
          "the child wrote under a read-only projection, so the declared mode is not enforced",
      };
    }
    return {
      observation: "supported",
      detail: `a read-only projection blocked a write the same child performed when permitted${
        treatment.ok ? "" : ` (treatment turn also reported: ${treatment.detail})`
      }`,
    };
  } finally {
    if (ownsWorkdir) rmSync(workdir, { recursive: true, force: true });
  }
}

async function runTurn(
  spawn: (request: SpawnRequest) => Promise<SpawnResult>,
  cwd: string,
  sentinel: string,
  mode: "read-only" | "workspace-write",
  opts: ProjectionProbeOptions,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const result = await spawn({
      prompt: projectionPrompt(sentinel),
      timeoutMs: opts.timeoutMs,
      maxTurns: PROJECTION_MAX_TURNS,
      cwd,
      subscriptionOnly: opts.subscriptionOnly,
      filesystemPolicy: { mode },
    });
    return { ok: result.ok, detail: result.ok ? "completed" : boundedDetail(result.error) };
  } catch (error) {
    return { ok: false, detail: boundedDetail((error as Error).message) };
  }
}

const MAX_DETAIL_CHARS = 160;

/** Same tail-preserving rule as the main probe: a CLI prints its banner first
 * and the reason it failed last. */
function boundedDetail(reason: string | undefined): string {
  if (!reason) return "no error reported";
  const collapsed = reason.replace(/\s+/g, " ").trim();
  if (!collapsed) return "no error reported";
  return collapsed.length > MAX_DETAIL_CHARS ? `…${collapsed.slice(-MAX_DETAIL_CHARS)}` : collapsed;
}
