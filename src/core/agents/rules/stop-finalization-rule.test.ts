import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventV3Fixture, fixtureObject } from "../../../../tests/helpers/event-v3.ts";
import type { EventV3 } from "../../events/v3/contract.ts";
import type { GitFinalizationResult } from "../finalization.ts";
import type { StopGitFinalization } from "../stop-finalization.ts";
import { evaluateStopHookV3Events } from "./stop-hook.ts";

const OWNER = "inst_operator";
const START = Date.parse("2026-11-04T12:00:00.000Z");
const roots: string[] = [];
const clean: GitFinalizationResult = {
  ok: true,
  claim_history_complete: true,
  dirty_paths: [],
  unpushed_repos: [],
  behind_repos: [],
  stale_submodules: [],
  diverged_submodules: [],
  host_output_paths: [],
  unsupported_paths: [],
  unverifiable_paths: [],
  unverifiable_repos: [],
  repos_checked: ["."],
};
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(type: string, second: number): EventV3 {
  const value = eventV3Fixture(type, second + 1);
  Object.assign(fixtureObject(value.scope), {
    instance_id: OWNER,
    generation_id: "gen_00000000-0000-7000-8000-000000000111",
  });
  fixtureObject(value.time).observed_at = new Date(START + second * 1000).toISOString();
  if (type === "coord.task_changed" || type === "coord.status_observed") {
    fixtureObject(value.payload).subject_instance_id = OWNER;
  }
  if (type === "coord.status_observed") fixtureObject(value.payload).status = "end_turn_checked";
  return value as unknown as EventV3;
}

function verdict(
  finalState: StopGitFinalization | undefined,
  opts: {
    box?: boolean;
    task?: boolean;
    status?: boolean;
    host?: boolean;
    naming?: boolean;
    adapter?: string;
    pending?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "harn-stop-final-git-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"));
  writeFileSync(
    join(root, ".harnery/config.jsonc"),
    JSON.stringify({ agents: { requireGitFinalization: opts.host ?? true } }),
  );
  const events = [event("turn.started", 0), event("tool.requested", 1)];
  if (opts.task !== false) events.push(event("coord.task_changed", 2));
  if (opts.status !== false) events.push(event("coord.status_observed", 3));
  events.push(event("tool.requested", 4), event("tool.completed", 5));
  const terminal = event("turn.completed", 6);
  const observed = (value: unknown) => ({
    state: "observed",
    value,
    attestation: "derived",
    confidence: "exact",
  });
  fixtureObject(terminal.payload).ritual = {
    status_box_present_strict: observed(opts.box ?? true),
    session_name: observed({ required: opts.naming ?? false, present: false }),
  };
  events.push(terminal);
  return evaluateStopHookV3Events(
    root,
    {
      rule: "stop-hook",
      instance_id: "operator",
      adapter: opts.adapter ?? "claude-code",
      now_ms: START + 7000,
      final_git_state: finalState,
      pending_background_handoff: opts.pending,
    },
    events,
  );
}

describe("Stop supplemental owned Git observation", () => {
  test("later dirty work blocks while a later harmless operation with clean Git passes", () => {
    const dirty = verdict({
      state: "observed",
      result: { ...clean, ok: false, dirty_paths: ["owned.ts"] },
    });
    expect(dirty).toMatchObject({ allow: false, rule: "stop-hook.git_not_finalized" });
    expect(dirty.reason).toContain("owned.ts");
    expect(dirty.reason).toContain("paste its box");
    expect(verdict({ state: "observed", result: clean })).toMatchObject({
      allow: true,
      rule: "stop-hook.pass",
    });
  });

  test("unavailable does not skip box, task, or naming rules", () => {
    const result = verdict(
      { state: "unavailable", reason: "check_timeout" },
      { box: false, task: false, naming: true },
    );
    expect(result.allow).toBe(false);
    expect(result.reason).toContain("End-of-turn rule (2/3)");
    expect(result.reason).toContain("End-of-turn rule (3/3)");
    expect(result.reason).toContain("session");
    expect(verdict(undefined, { status: false })).toMatchObject({
      allow: false,
      rule: "stop-hook.rule_1_3",
    });
  });

  test("known history, authority, and verification failures remain blocking observations", () => {
    const failures: Partial<GitFinalizationResult>[] = [
      { claim_history_complete: false },
      { unpushed_repos: ["."] },
      { unsupported_paths: [{ path: "external.ts", reason: "outside_finalization_roots" }] },
      { unverifiable_paths: ["owned.ts"] },
      { unverifiable_repos: ["."] },
    ];
    for (const failure of failures) {
      expect(
        verdict({ state: "observed", result: { ...clean, ...failure, ok: false } }),
      ).toMatchObject({ allow: false, rule: "stop-hook.git_not_finalized" });
    }
  });

  test("host opt-in, Codex observe-only, and background handoff policies remain unchanged", () => {
    const bad: StopGitFinalization = {
      state: "observed",
      result: { ...clean, ok: false, dirty_paths: ["owned.ts"] },
    };
    expect(verdict(bad, { host: false })).toMatchObject({ allow: true });
    expect(verdict(bad, { adapter: "codex" })).toMatchObject({
      allow: true,
      rule: "stop-hook.codex_observe_only",
    });
    expect(verdict(bad, { pending: true })).toMatchObject({
      allow: true,
      rule: "stop-hook.background_handoff_deferred",
    });
  });
});
