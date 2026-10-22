import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventV3Fixture, fixtureObject } from "../../../../tests/helpers/event-v3.ts";
import {
  type CoordinationGenerationViewV3,
  type CoordinationViewV3,
  projectCoordinationViewV3,
} from "../../events/v3/coordination-view.ts";
import type { NativeParentObservation } from "../../hooks/adapter/native-parent.ts";
import { indexCoordinationGenerationsV3 } from "./live-coordination-view.ts";
import { resolveAgentParentReference } from "./parent-reference.ts";

const CHILD = "00000000-0000-4000-8000-000000000001";
const PARENT = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000003";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function generation(id: string, generationId: string): CoordinationGenerationViewV3 {
  const payload = fixtureObject(eventV3Fixture("session.started", 1).payload);
  const attestation = fixtureObject(payload.runtime_attestation);
  attestation.adapter = { state: "observed", value: { id: "codex" } };
  return {
    contract_major: 2,
    instance_id: `inst_${id}`,
    session_id: `sid_${id}`,
    generation_id: generationId,
    root_id: "root_fixture",
    runtime_attestation: attestation as CoordinationGenerationViewV3["runtime_attestation"],
    phase: "live",
    activity: "working",
    started_at: "2026-08-28T22:00:00Z",
    last_observed_at: "2026-08-28T22:00:00Z",
    last_event_id: "evt_fixture",
    source_position: { segment_ordinal: 1, byte_offset: 1 },
    waits: [],
    files_touched: [],
    progress_count: 0,
    evidence_complete: true,
    authority_eligible: true,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "parent-reference-"));
  roots.push(root);
  mkdirSync(join(root, ".harnery"));
  appendFileSync(
    join(root, ".harnery/.name-history"),
    `${JSON.stringify({
      instance_id: PARENT,
      name: "Maya",
      kind: "session",
      ts: "2026-08-28T22:00:00Z",
    })}\n`,
  );
  const view = projectCoordinationViewV3({
    events: [],
    complete: true,
    diagnostics: [],
    advances: [],
    bytes: 0,
  });
  const child = generation(CHILD, "gen_child");
  const parent = generation(PARENT, "gen_parent");
  view.instances[child.instance_id] = child;
  view.instances[parent.instance_id] = parent;
  const subject = { instance_id: CHILD, v3_generation_id: child.generation_id, platform: "codex" };
  const native = (): NativeParentObservation => ({
    state: "observed",
    parent_session_id: PARENT,
    source_witness: "a".repeat(64),
  });
  return { root, view, child, parent, subject, native };
}

test("canonical parent resolves an ended exact generation without substituting its newer generation", () => {
  const { root, view, child, parent, subject } = fixture();
  child.parent_generation_id = parent.generation_id;
  parent.phase = "terminal";
  view.terminal_generations[parent.generation_id] = parent;
  view.instances[parent.instance_id] = generation(PARENT, "gen_new_parent");
  expect(
    resolveAgentParentReference(root, subject, {
      view,
      readNativeParent: () => ({ state: "unknown", reason: "unavailable" }),
    }),
  ).toMatchObject({
    state: "verified",
    source: "v3-session-link",
    parent_generation_id: "gen_parent",
    parent_v3_instance_id: `inst_${PARENT}`,
    addressable: false,
  });
});

test("both live readers' canonical index preserves the terminal parent beside its replacement", () => {
  const { view, child, parent } = fixture();
  child.parent_generation_id = parent.generation_id;
  parent.phase = "terminal";
  view.terminal_generations[parent.generation_id] = parent;
  const replacement = generation(PARENT, "gen_new_parent");
  view.instances[parent.instance_id] = replacement;
  const index = indexCoordinationGenerationsV3(view);
  expect(index.get(child.parent_generation_id)).toBe(parent);
  expect(index.get(replacement.generation_id)).toBe(replacement);
  expect(index.get("gen_missing")).toBeUndefined();
});

test("epoch-reanchored child can expose native evidence without creating a V3 relationship", () => {
  const { root, view, child, subject, native } = fixture();
  const before = JSON.stringify(view);
  expect(resolveAgentParentReference(root, subject, { view, readNativeParent: native })).toEqual({
    state: "verified",
    relationship: "native-child",
    parent_instance_id: PARENT,
    parent_v3_instance_id: `inst_${PARENT}`,
    parent_generation_id: "gen_parent",
    parent_session_id: `sid_${PARENT}`,
    parent_name: "Maya",
    source: "native-session-metadata",
    source_witness: "a".repeat(64),
    addressable: true,
  });
  expect(child.parent_generation_id).toBeUndefined();
  expect(JSON.stringify(view)).toBe(before);
});

test("an observed native relationship is unaddressable when the parent has no safe recipient identity", () => {
  const { root, view, parent, subject, native } = fixture();
  delete view.instances[parent.instance_id];
  expect(
    resolveAgentParentReference(root, subject, { view, readNativeParent: native }),
  ).toMatchObject({
    state: "verified",
    addressable: false,
    parent_generation_id: null,
    parent_session_id: null,
  });
});

test("incomplete source, unsafe source and mismatched child generation never call native discovery", () => {
  const { root, view, subject, native } = fixture();
  let calls = 0;
  const readNativeParent = () => {
    calls++;
    return native();
  };
  for (const mutation of [
    () => {
      view.source_complete = false;
    },
    () => {
      view.source_complete = true;
      view.authority_safe = false;
    },
  ]) {
    mutation();
    expect(resolveAgentParentReference(root, subject, { view, readNativeParent }).state).toBe(
      "unknown",
    );
  }
  view.authority_safe = true;
  expect(
    resolveAgentParentReference(
      root,
      { ...subject, generation_id: "gen_wrong" },
      { view, readNativeParent },
    ).state,
  ).toBe("unknown");
  expect(calls).toBe(0);
});

test("disagreement with a canonical parent or positive ordinary session is an explicit conflict", () => {
  const { root, view, child, parent, subject } = fixture();
  child.parent_generation_id = parent.generation_id;
  for (const observation of [
    { state: "observed", parent_session_id: OTHER, source_witness: "b" },
    { state: "none", reason: "native_ordinary_session", source_witness: "b" },
  ] satisfies NativeParentObservation[]) {
    expect(
      resolveAgentParentReference(root, subject, { view, readNativeParent: () => observation }),
    ).toEqual({ state: "conflict", reason: "parent_sources_disagree" });
  }
});

test("missing canonical generation is not bypassed by a native fallback", () => {
  const { root, view, child, subject, native } = fixture();
  child.parent_generation_id = "gen_missing";
  let calls = 0;
  expect(
    resolveAgentParentReference(root, subject, {
      view,
      readNativeParent: () => {
        calls++;
        return native();
      },
    }),
  ).toEqual({ state: "unknown", reason: "parent_generation_unavailable" });
  expect(calls).toBe(0);
});

test("canonical and native cycles are rejected instead of creating ancestor fanout", () => {
  const { root, view, child, parent, subject, native } = fixture();
  parent.parent_generation_id = child.generation_id;
  expect(resolveAgentParentReference(root, subject, { view, readNativeParent: native }).state).toBe(
    "conflict",
  );
  child.parent_generation_id = parent.generation_id;
  expect(resolveAgentParentReference(root, subject, { view, readNativeParent: native }).state).toBe(
    "conflict",
  );
});

test("name reuse affects presentation only and cannot retarget the parent instance", () => {
  const { root, view, subject, native } = fixture();
  appendFileSync(
    join(root, ".harnery/.name-history"),
    `${JSON.stringify({
      instance_id: OTHER,
      name: "Maya",
      kind: "session",
      ts: "2026-08-28T22:01:00Z",
    })}\n`,
  );
  view.instances[`inst_${OTHER}`] = generation(OTHER, "gen_other");
  expect(
    resolveAgentParentReference(root, subject, { view, readNativeParent: native }),
  ).toMatchObject({
    state: "verified",
    parent_v3_instance_id: `inst_${PARENT}`,
    parent_name: "Maya",
  });
});

test("missing native evidence stays unknown while positive ordinary metadata can say none", () => {
  const { root, view, subject } = fixture();
  expect(
    resolveAgentParentReference(root, subject, {
      view,
      readNativeParent: () => ({ state: "unknown", reason: "missing" }),
    }),
  ).toEqual({ state: "unknown", reason: "missing" });
  expect(
    resolveAgentParentReference(root, subject, {
      view,
      readNativeParent: () => ({ state: "none", reason: "ordinary", source_witness: "x" }),
    }),
  ).toEqual({ state: "none", reason: "ordinary" });
});

test("a later unsafe parent generation prevents recipient admission even when old lineage is valid", () => {
  const { root, view, child, parent, subject, native } = fixture();
  child.parent_generation_id = parent.generation_id;
  parent.phase = "terminal";
  view.terminal_generations[parent.generation_id] = parent;
  const current = generation(PARENT, "gen_new_parent");
  view.instances[parent.instance_id] = current;
  view.diagnostics_by_generation[current.generation_id] = [
    { authority_blocking: true } as CoordinationViewV3["diagnostics"][number],
  ];
  expect(
    resolveAgentParentReference(root, subject, { view, readNativeParent: native }),
  ).toMatchObject({ state: "verified", addressable: false });
});

test("a safe replacement cannot make an unsafe historical parent generation addressable", () => {
  const { root, view, child, parent, subject, native } = fixture();
  child.parent_generation_id = parent.generation_id;
  parent.phase = "terminal";
  view.terminal_generations[parent.generation_id] = parent;
  view.instances[parent.instance_id] = generation(PARENT, "gen_safe_replacement");
  view.diagnostics_by_generation[parent.generation_id] = [
    { authority_blocking: true } as CoordinationViewV3["diagnostics"][number],
  ];
  expect(
    resolveAgentParentReference(root, subject, { view, readNativeParent: native }),
  ).toMatchObject({
    state: "verified",
    parent_generation_id: "gen_parent",
    addressable: false,
  });
});
