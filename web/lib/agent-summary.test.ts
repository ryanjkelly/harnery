/**
 * Locks the live-layer subagent parent linkage (resolveSubagentLinkage). The
 * invariant that matters: a RUNNING subagent's live-heartbeat summary entry,
 * which wins the page-level `{...ended, ...subagent, ...live}` merge, must
 * carry `parent` + `agent_type` itself, resolved from data already on disk
 * (heartbeat session_id → parent heartbeat instance_id; agent_type from the
 * durable identities map). Before this, the live entry left both undefined and
 * clobbered the identity-derived entry, so a live subagent rendered "parent
 * exited" for its whole runtime and only resolved at exit.
 */

import { describe, expect, test } from "bun:test";
import type { InstanceIdentity } from "./coord-reader.ts";
import { resolveSubagentLinkage, sessionMetaByName } from "./agent-summary.ts";

const PARENT_ID = "f3b64d7c-fa54-4900-a317-f478842c2dd4";
const SUB_ID = "a7c3f60229ca9bdc0";

function liveMap(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries));
}

function identity(overrides: Partial<InstanceIdentity>): Record<string, InstanceIdentity> {
  const id: InstanceIdentity = {
    instance_id: SUB_ID,
    name: "Paxton",
    kind: "subagent",
    agent_type: "Explore",
    session_id: PARENT_ID,
    ...overrides,
  };
  return { [id.instance_id]: id };
}

describe("resolveSubagentLinkage", () => {
  test("non-subagent kinds resolve to null (no enrichment spread)", () => {
    const idToName = liveMap({ [PARENT_ID]: "Owen" });
    expect(
      resolveSubagentLinkage({ kind: "session", instance_id: PARENT_ID, session_id: PARENT_ID }, idToName),
    ).toBeNull();
    expect(resolveSubagentLinkage({ instance_id: SUB_ID, session_id: PARENT_ID }, idToName)).toBeNull();
    expect(resolveSubagentLinkage({ kind: null, session_id: PARENT_ID }, idToName)).toBeNull();
  });

  test("live subagent resolves parent name + agent_type while parent heartbeat exists", () => {
    const idToName = liveMap({ [PARENT_ID]: "Owen", [SUB_ID]: "Paxton" });
    const out = resolveSubagentLinkage(
      { kind: "subagent", instance_id: SUB_ID, session_id: PARENT_ID },
      idToName,
      identity({}),
    );
    expect(out).toEqual({ parent: "Owen", agent_type: "Explore" });
  });

  test("agent- prefix on the parent heartbeat name is stripped (chip adds its own)", () => {
    const idToName = liveMap({ [PARENT_ID]: "agent-Owen" });
    const out = resolveSubagentLinkage(
      { kind: "subagent", instance_id: SUB_ID, session_id: PARENT_ID },
      idToName,
    );
    expect(out?.parent).toBe("Owen");
  });

  test("parent heartbeat gone → parent null (renders 'parent exited', now truthfully)", () => {
    const out = resolveSubagentLinkage(
      { kind: "subagent", instance_id: SUB_ID, session_id: PARENT_ID },
      liveMap({ [SUB_ID]: "Paxton" }),
      identity({}),
    );
    expect(out).toEqual({ parent: null, agent_type: "Explore" });
  });

  test("self-referential session_id (malformed heartbeat) never names itself as parent", () => {
    const out = resolveSubagentLinkage(
      { kind: "subagent", instance_id: SUB_ID, session_id: SUB_ID },
      liveMap({ [SUB_ID]: "Paxton" }),
    );
    expect(out).toEqual({ parent: null, agent_type: null });
  });

  test("missing session_id or identities degrade to nulls, not throws", () => {
    expect(resolveSubagentLinkage({ kind: "subagent", instance_id: SUB_ID }, liveMap({}))).toEqual({
      parent: null,
      agent_type: null,
    });
    const out = resolveSubagentLinkage(
      { kind: "subagent", instance_id: SUB_ID, session_id: PARENT_ID },
      liveMap({ [PARENT_ID]: "Owen" }),
      identity({ agent_type: undefined }),
    );
    expect(out).toEqual({ parent: "Owen", agent_type: null });
  });
});

describe("sessionMetaByName", () => {
  function session(
    instance_id: string,
    name: string,
    platform: string | null,
    last_ts: string,
    opts: { kind?: InstanceIdentity["kind"]; model?: string | null } = {},
  ): InstanceIdentity {
    return {
      instance_id,
      name,
      kind: opts.kind ?? "session",
      platform,
      model: opts.model ?? null,
      last_ts,
    };
  }

  test("derives {platform, model} per bare name (agent- prefix stripped, case-folded)", () => {
    const out = sessionMetaByName({
      a: session("a", "agent-Celeste", "claude_code", "2026-06-10T20:00:00Z", {
        model: "claude-fable-5",
      }),
      b: session("b", "Zephyr", "codex", "2026-06-10T20:00:00Z", { model: "gpt-5.5" }),
    });
    expect(out.get("celeste")).toEqual({ platform: "claude_code", model: "claude-fable-5" });
    expect(out.get("zephyr")).toEqual({ platform: "codex", model: "gpt-5.5" });
  });

  test("newest session wins on a repeated name, as a unit (no cross-session field mixing)", () => {
    const out = sessionMetaByName({
      old: session("old", "agent-Wren", "cursor", "2026-06-01T00:00:00Z", {
        model: "composer-2.5-fast",
      }),
      neu: session("neu", "agent-Wren", "claude_code", "2026-06-10T00:00:00Z"),
    });
    // The newest session hasn't reported a model yet; the older session's
    // model must NOT leak through (it belonged to a different harness).
    expect(out.get("wren")).toEqual({ platform: "claude_code", model: null });
  });

  test("ignores subagents, meta-less sessions, and missing identities", () => {
    const out = sessionMetaByName({
      sub: session("sub", "agent-Pax", "claude_code", "2026-06-10T00:00:00Z", {
        kind: "subagent",
      }),
      bare: session("bare", "agent-Quinn", null, "2026-06-10T00:00:00Z"),
    });
    expect(out.size).toBe(0);
    expect(sessionMetaByName(undefined).size).toBe(0);
  });
});
