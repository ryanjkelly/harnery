import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initializeEventLedgerV3, refreshIncompatibleEventLedgerV3 } from "./bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import { liveGenesisIdV3 } from "./control.ts";
import { scanEventHistoryV3 } from "./history.ts";
import { recordHookSignalV3 } from "./producers/recorder.ts";
import { readLedgerV3 } from "./reader.ts";
import { importArchivedReadyEventsV3 } from "./ready-history.ts";
import { eventV3Paths, withEventV3LedgerLease, withEventV3PublicationLease } from "./writer.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const oldDigest = `sha256:${"a".repeat(64)}`;
const epoch = "epoch-20261104164357439";

test("schema cutover carries a deferred old-schema batch into its original searchable epoch", () => {
  const fixture = stagedFixture();
  const before = scanEventHistoryV3(fixture.root).rows;
  expect(before.some(({ event_id }) => fixture.ids.includes(event_id))).toBeFalse();
  const refreshed = refreshIncompatibleEventLedgerV3(fixture.root);
  expect(refreshed.state).toBe("refreshed");
  const history = scanEventHistoryV3(fixture.root).rows;
  for (const id of fixture.ids) {
    expect(history.filter(({ event_id }) => event_id === id)).toEqual([
      expect.objectContaining({ epoch: basename(refreshed.archived_epoch!), event_id: id }),
    ]);
  }
  expect(readLedgerV3(fixture.root)).toMatchObject({ complete: true, diagnostics: [] });
  expect(
    readLedgerV3(fixture.root).events.some(({ event }) => fixture.ids.includes(event.event_id)),
  ).toBeFalse();
});

test("cutover refuses a busy append or publication lease without moving ready evidence", () => {
  const fixture = stagedFixture();
  const before = snapshot(fixture.dir);
  withEventV3LedgerLease(fixture.root, {}, () => {
    expect(() => refreshIncompatibleEventLedgerV3(fixture.root)).toThrow("event-v3-append");
  });
  expect(snapshot(fixture.dir)).toEqual(before);
  withEventV3PublicationLease(fixture.root, () => {
    expect(() => refreshIncompatibleEventLedgerV3(fixture.root)).toThrow("event-v3-publication");
  });
  expect(snapshot(fixture.dir)).toEqual(before);
  expect(refreshIncompatibleEventLedgerV3(fixture.root).state).toBe("refreshed");
});

test("a cutover cannot borrow a nested publisher's lease before its ready rename", () => {
  const root = freshRoot();
  const initialize = {
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("fixture"),
    approvalRecordId: "fixture",
  };
  initializeEventLedgerV3(initialize);
  const genesis = liveGenesisIdV3(root);
  let interrupted = false;
  expect(
    recordHookSignalV3({
      coordRoot: root,
      mode: "active",
      signal: "user-prompt-submit",
      payload: { session_id: "fixture-session", turn_id: "fixture-turn", raw: {} },
      adapter: "claude-code",
      instance_id: "inst_fixture",
      producer_id: "prd_agent-hook",
      build_id: "build_fixture",
      platform: "linux",
      writerOptions: {
        onStep: (step) => {
          if (step !== "ready_temp_flushed" || interrupted) return;
          interrupted = true;
          expect(() => initializeEventLedgerV3({ ...initialize, forceNewEpoch: true })).toThrow(
            "event-v3-publication",
          );
          expect(liveGenesisIdV3(root)).toBe(genesis);
        },
      },
    }).state,
  ).toBe("recorded");
  expect(interrupted).toBeTrue();
  const ids = readLedgerV3(root).events.map(({ event }) => event.event_id);
  const cutover = initializeEventLedgerV3({ ...initialize, forceNewEpoch: true });
  const history = scanEventHistoryV3(root).rows;
  for (const id of ids) {
    expect(history.filter(({ event_id }) => event_id === id)).toEqual([
      expect.objectContaining({ epoch: basename(cutover.archived_epoch!), event_id: id }),
    ]);
  }
  expect(readLedgerV3(root)).toMatchObject({ complete: true, diagnostics: [] });
});

test("explicit recovery dry-runs without writes, imports an archive copy once, and preserves the source", () => {
  const original = archivedFixture();
  const before = snapshot(original.dir);
  const root = freshRoot();
  const dir = join(root, ".harnery", "ledgers", "v3-archives", epoch);
  cpSync(original.dir, dir, { recursive: true });
  const plan = importArchivedReadyEventsV3(root, epoch, { maxEvents: 4 });
  expect(plan).toMatchObject({ state: "dry_run", already_present: 0 });
  expect(plan.events.map(({ event_id }) => event_id).sort()).toEqual([...original.ids].sort());
  expect(snapshot(dir)).toEqual(before);
  expect(() => importArchivedReadyEventsV3(root, epoch, { maxEvents: 1 })).toThrow("max-events");
  expect(importArchivedReadyEventsV3(root, epoch, { yes: true }).events).toHaveLength(
    original.ids.length,
  );
  const imported = readFileSync(join(dir, "active.ndjson"), "utf8");
  expect(importArchivedReadyEventsV3(root, epoch, { yes: true })).toMatchObject({
    events: [],
    already_present: original.ids.length,
  });
  expect(readFileSync(join(dir, "active.ndjson"), "utf8")).toBe(imported);
  expect(snapshot(original.dir)).toEqual(before);
  for (const id of original.ids)
    expect(scanEventHistoryV3(root).rows.filter(({ event_id }) => event_id === id)).toHaveLength(1);
  expect(existsSync(eventV3Paths(root).root)).toBeFalse();
});

test("recovery resumes after a partial append using the durable frame as proof", () => {
  const fixture = archivedFixture();
  const plan = importArchivedReadyEventsV3(fixture.root, epoch);
  const first = readyNames(fixture.dir).find(
    (name) =>
      JSON.parse(readFileSync(join(fixture.dir, "spool", name), "utf8")).event_id ===
      plan.events[0]!.event_id,
  )!;
  appendFileSync(
    join(fixture.dir, "active.ndjson"),
    readFileSync(join(fixture.dir, "spool", first)).subarray(0, 100),
  );
  expect(importArchivedReadyEventsV3(fixture.root, epoch, { yes: true }).events).toHaveLength(
    fixture.ids.length,
  );
  for (const id of fixture.ids)
    expect(
      scanEventHistoryV3(fixture.root).rows.filter(({ event_id }) => event_id === id),
    ).toHaveLength(1);
});

test("recovery rejects a conflicting committed event ID before appending any rows", () => {
  const fixture = archivedFixture();
  const ready = JSON.parse(
    readFileSync(join(fixture.dir, "spool", readyNames(fixture.dir)[0]!), "utf8"),
  );
  const active = join(fixture.dir, "active.ndjson");
  const committed = JSON.parse(readFileSync(active, "utf8").split("\n")[0]!);
  ready.event_id = committed.event_id;
  if (ready.payload.runtime_attestation) {
    ready.payload.runtime_attestation.declared_by_event_id = ready.event_id;
  }
  const row = `${canonicalJsonV3(ready)}\n`;
  writeFileSync(
    join(
      fixture.dir,
      "spool",
      `${String(ready.producer.sequence).padStart(16, "0")}-${ready.event_id}-${sha256V3(row).slice(7)}.ready`,
    ),
    row,
  );
  const before = readFileSync(active, "utf8");
  expect(() => importArchivedReadyEventsV3(fixture.root, epoch, { yes: true })).toThrow("conflict");
  expect(readFileSync(active, "utf8")).toBe(before);
});

test("recovery orders an attestation change after its prior declaration", () => {
  const fixture = archivedFixture();
  const ready = readyNames(fixture.dir).map((name) =>
    JSON.parse(readFileSync(join(fixture.dir, "spool", name), "utf8")),
  );
  const session = ready.find((event) => event.event_type === "session.started");
  const last = [...ready].sort((a, b) => a.producer.sequence - b.producer.sequence).at(-1);
  const change = structuredClone(session);
  change.event_type = "session.attestation_changed";
  change.event_id = "evt_00000000-0000-7000-8000-000000000999";
  change.attestation_id = "att_00000000-0000-7000-8000-000000000999";
  change.producer = { ...last.producer, sequence: last.producer.sequence + 1 };
  change.time = last.time;
  change.links = { caused_by: [last.event_id] };
  change.payload = {
    prior_attestation_id: session.attestation_id,
    runtime_attestation: {
      ...session.payload.runtime_attestation,
      attestation_id: change.attestation_id,
      declared_by_event_id: change.event_id,
    },
    reason: "fixture_changed",
  };
  const row = `${canonicalJsonV3(change)}\n`;
  writeFileSync(
    join(
      fixture.dir,
      "spool",
      `${String(change.producer.sequence).padStart(16, "0")}-${change.event_id}-${sha256V3(row).slice(7)}.ready`,
    ),
    row,
  );
  const result = importArchivedReadyEventsV3(fixture.root, epoch, { yes: true });
  expect(result.events.at(-1)?.event_id).toBe(change.event_id);
  expect(result.events).toHaveLength(fixture.ids.length + 1);
});

test("recovery refuses corrupt frames, missing parents, and symlink targets before writing", () => {
  const fixture = archivedFixture();
  const ready = join(fixture.dir, "spool", readyNames(fixture.dir)[0]!);
  const original = readFileSync(ready, "utf8");
  const before = readFileSync(join(fixture.dir, "active.ndjson"), "utf8");
  writeFileSync(ready, original.replace('"harnery.event"', '"invalid.event"'));
  expect(() => importArchivedReadyEventsV3(fixture.root, epoch, { yes: true })).toThrow();
  writeFileSync(ready, original);
  const event = JSON.parse(original);
  event.links.caused_by = ["evt_00000000-0000-7000-8000-999999999999"];
  const row = `${canonicalJsonV3(event)}\n`;
  const name = `${String(event.producer.sequence).padStart(16, "0")}-${event.event_id}-${sha256V3(row).slice(7)}-${event.epoch_tag ?? JSON.parse(readFileSync(join(fixture.dir, "genesis.json"), "utf8")).event.payload.genesis_id}.ready`;
  rmSync(ready);
  writeFileSync(join(fixture.dir, "spool", name), row);
  expect(() => importArchivedReadyEventsV3(fixture.root, epoch, { yes: true })).toThrow("causal");
  expect(readFileSync(join(fixture.dir, "active.ndjson"), "utf8")).toBe(before);
  expect(() => importArchivedReadyEventsV3(fixture.root, "../v3", { yes: true })).toThrow("exact");
  const link = join(fixture.dir, "..", "epoch-20261104164357440");
  symlinkSync(fixture.dir, link);
  expect(() => importArchivedReadyEventsV3(fixture.root, basename(link), { yes: true })).toThrow(
    "symlinks",
  );
});

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-ready-history-"));
  roots.push(root);
  return root;
}
function stagedFixture() {
  const root = freshRoot();
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("fixture"),
    approvalRecordId: "fixture",
  });
  const base = {
    coordRoot: root,
    mode: "active" as const,
    adapter: "claude-code" as const,
    instance_id: "inst_fixture" as const,
    producer_id: "prd_agent-hook" as const,
    build_id: "build_fixture" as const,
    platform: "linux" as const,
  };
  for (const signal of ["session-start", "user-prompt-submit", "pre-tool-use"] as const) {
    expect(
      recordHookSignalV3({
        ...base,
        signal,
        payload: {
          session_id: "fixture-session",
          turn_id: "fixture-turn",
          tool_use_id: "fixture-tool",
          tool_name: "Read",
          raw: {},
        },
        writerOptions: { deferDrain: true },
      }).state,
    ).toBe("recorded");
  }
  const dir = eventV3Paths(root).root;
  const genesisId = liveGenesisIdV3(root);
  const ids: string[] = [];
  for (const name of readyNames(dir)) {
    const path = join(dir, "spool", name);
    const event = JSON.parse(readFileSync(path, "utf8"));
    ids.push(event.event_id);
    event.contract.schema_digest = oldDigest;
    const row = `${canonicalJsonV3(event)}\n`;
    rmSync(path);
    writeFileSync(
      join(
        dir,
        "spool",
        `${String(event.producer.sequence).padStart(16, "0")}-${event.event_id}-${sha256V3(row).slice(7)}-${genesisId}.ready`,
      ),
      row,
    );
  }
  const events = readFileSync(join(dir, "active.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const event of events) {
    event.contract.schema_digest = oldDigest;
    if (event.event_type === "ledger.genesis") event.payload.generated_schema_digest = oldDigest;
  }
  writeFileSync(
    join(dir, "active.ndjson"),
    events.map((event) => `${canonicalJsonV3(event)}\n`).join(""),
  );
  const manifest = JSON.parse(readFileSync(join(dir, "genesis.json"), "utf8"));
  manifest.profile.initial_schema_digest = oldDigest;
  manifest.event = events[0];
  writeFileSync(join(dir, "genesis.json"), `${canonicalJsonV3(manifest)}\n`);
  return { root, dir, ids };
}
function archivedFixture() {
  const fixture = stagedFixture();
  const dir = join(fixture.root, ".harnery", "ledgers", "v3-archives", epoch);
  mkdirSync(join(dir, ".."), { recursive: true });
  renameSync(fixture.dir, dir);
  return { ...fixture, dir };
}
function readyNames(dir: string): string[] {
  return readdirSync(join(dir, "spool"))
    .filter((name) => name.endsWith(".ready"))
    .sort();
}
function snapshot(dir: string) {
  return {
    active: readFileSync(join(dir, "active.ndjson"), "utf8"),
    ready: readyNames(dir).map((name) => [name, readFileSync(join(dir, "spool", name), "utf8")]),
  };
}
