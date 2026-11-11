import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CASES,
  evaluateCheck,
  type FileFacts,
  type Fingerprint,
  measureRoot,
  parseArgs,
  parseCheck,
  parseStatus,
  parseStep,
  type StepRecord,
  sha256,
  stagedFate,
} from "../../scripts/rehearse-event-v3-upgrade.ts";
import { removeDir } from "../helpers/remove-dir.ts";

// Pure parts of the upgrade rehearsal. The rehearsal itself needs the npm
// registry and two packed builds, so it runs as its own CI step, not here.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeDir(root);
});

const facts = (over: Partial<FileFacts> = {}): FileFacts => ({
  active_bytes: 10,
  active_sha256: "sha256:a",
  archives: 0,
  genesis_id: "gex_1",
  spool_files: [],
  ...over,
});
const record = (label: string, before: FileFacts, after: FileFacts, over = {}): StepRecord => ({
  label,
  action: "hook",
  exit: 0,
  before,
  after,
  status: {},
  ...over,
});
const print = (over: Partial<Fingerprint> = {}): Fingerprint => ({
  version: "1.0.0",
  manifest_version: 1,
  schema_digest: "sha256:s",
  capability_digests: ["sha256:c1", "sha256:c2"],
  ...over,
});
const same = { baseline: print(), candidate: print() };
const newer = { baseline: print(), candidate: print({ manifest_version: 2 }) };

describe("rehearsal arguments", () => {
  test("defaults and flags", () => {
    expect(parseArgs([], "/checkout")).toEqual({
      candidate: "/checkout",
      baseline: "0.53.1",
      json: false,
      keep: false,
    });
    const parsed = parseArgs(
      ["--baseline", "0.50.0", "--case", "alternation", "--json", "--keep"],
      "/c",
    );
    expect(parsed).toMatchObject({
      baseline: "0.50.0",
      caseName: "alternation",
      json: true,
      keep: true,
    });
  });

  test("rejects unknown flags, missing values and unknown cases", () => {
    expect(() => parseArgs(["--nope"], "/c")).toThrow("unknown argument");
    expect(() => parseArgs(["--baseline"], "/c")).toThrow("needs a value");
    expect(() => parseArgs(["--case", "--json"], "/c")).toThrow("needs a value");
    expect(() => parseArgs(["--case", "missing"], "/c")).toThrow("unknown case");
  });
});

describe("case data", () => {
  test("names are the fixed set and every check names a step of its case", () => {
    expect(CASES.map((entry) => entry.name)).toEqual([
      "candidate-serves-baseline-epoch",
      "baseline-meets-written-epoch-witness",
      "baseline-meets-written-epoch-full-read",
      "baseline-meets-candidate-epoch",
      "rotation-with-both",
      "alternation",
      "baseline-explicit-init",
      "baseline-explicit-initialize",
      "baseline-late-writer",
      "capability-digests-equal",
    ]);
    for (const entry of CASES) {
      const labels = new Set(entry.steps.map((step) => step.label));
      expect(labels.size).toBe(entry.steps.length);
      for (const check of entry.checks) {
        for (const key of ["step", "from", "to"] as const) {
          const label = (check as Record<string, unknown>)[key];
          if (typeof label === "string") expect(labels.has(label)).toBe(true);
        }
      }
    }
    const kinds = Object.fromEntries(CASES.map((entry) => [entry.name, entry.kind]));
    expect(kinds["baseline-explicit-init"]).toBe("record");
    expect(kinds["baseline-late-writer"]).toBe("record");
    expect(kinds["capability-digests-equal"]).toBe("must");
  });

  test("step specs", () => {
    expect(parseStep("b-rotate hook user-prompt-submit rotate")).toEqual({
      label: "b-rotate",
      build: "baseline",
      action: "hook",
      event: "user-prompt-submit",
      rotate: true,
    });
    expect(parseStep("stage stage-late-rows from=b-a,b-b")).toEqual({
      label: "stage",
      action: "stage-late-rows",
      from: ["b-a", "b-b"],
    });
    expect(() => parseStep("c-x hook")).toThrow("bad step");
    expect(() => parseStep("wipe init")).toThrow("bad step");
    expect(() => parseStep("c-x launch")).toThrow("bad step");
  });

  test("check specs", () => {
    expect(parseCheck("archives b-1..c-2 = 3 fenced")).toEqual({
      type: "archives",
      from: "b-1",
      to: "c-2",
      equals: 3,
      fenced: true,
    });
    expect(parseCheck("status baseline@b-x not-in active,candidate")).toEqual({
      type: "status_not_in",
      build: "baseline",
      step: "b-x",
      states: ["active", "candidate"],
    });
    expect(parseCheck("genesis-changed c-r")).toEqual({ type: "genesis_changed", step: "c-r" });
    expect(() => parseCheck("archives b-1 = 0")).toThrow("bad check");
    expect(() => parseCheck("status someone@b-x in active")).toThrow("bad check");
  });
});

describe("expectation evaluator", () => {
  test("appended requires growth with the prior bytes intact", () => {
    const grew = record("c", facts(), facts({ active_bytes: 20, prefix_sha256: "sha256:a" }));
    const replaced = record("c", facts(), facts({ active_bytes: 20, prefix_sha256: "sha256:b" }));
    const check = parseCheck("appended c");
    expect(evaluateCheck(check, [grew], same).verdict).toBe("pass");
    expect(evaluateCheck(check, [replaced], same).verdict).toBe("fail");
  });

  test("unchanged compares bytes, digest and archive count", () => {
    const check = parseCheck("unchanged b");
    const untouched = record("b", facts(), facts({ prefix_sha256: "sha256:a" }));
    const archived = record("b", facts(), facts({ archives: 1 }));
    expect(evaluateCheck(check, [untouched], same).verdict).toBe("pass");
    expect(evaluateCheck(check, [archived], newer).verdict).toBe("fail");
  });

  test("a failed fenced check is vacuous only while the epoch contracts are equal", () => {
    const wrote = record("b", facts(), facts({ active_bytes: 30, active_sha256: "sha256:z" }));
    const check = parseCheck("unchanged b fenced");
    expect(evaluateCheck(check, [wrote], same).verdict).toBe("vacuous");
    expect(evaluateCheck(check, [wrote], newer).verdict).toBe("fail");
    const differentSchema = { baseline: print(), candidate: print({ schema_digest: "sha256:t" }) };
    expect(evaluateCheck(check, [wrote], differentSchema).verdict).toBe("fail");
    const passing = record("b", facts(), facts());
    expect(evaluateCheck(check, [passing], same).verdict).toBe("pass");
  });

  test("archive deltas span from before the first step to after the last", () => {
    const steps = [
      record("a", facts({ archives: 2 }), facts({ archives: 3 })),
      record("z", facts({ archives: 3 }), facts({ archives: 3 })),
    ];
    expect(evaluateCheck(parseCheck("archives a..z = 1"), steps, same).verdict).toBe("pass");
    expect(evaluateCheck(parseCheck("archives z..z = 0"), steps, same).verdict).toBe("pass");
    expect(evaluateCheck(parseCheck("archives a..z = 0"), steps, same).verdict).toBe("fail");
  });

  test("genesis, status, staged rows and capability digests", () => {
    const rotated = record("r", facts(), facts({ genesis_id: "gex_2" }), {
      status: { baseline: { state: "invalid", reason: "x" }, candidate: { state: "active" } },
      staged: { evt_1: "spool.ready", evt_2: "spool.epoch-replaced" },
    });
    expect(evaluateCheck(parseCheck("genesis-changed r"), [rotated], same).verdict).toBe("pass");
    expect(evaluateCheck(parseCheck("genesis-same r..r"), [rotated], same).verdict).toBe("pass");
    const notServing = parseCheck("status baseline@r not-in active,candidate");
    expect(evaluateCheck(notServing, [rotated], same).verdict).toBe("pass");
    expect(evaluateCheck(parseCheck("status candidate@r in active"), [rotated], same).verdict).toBe(
      "pass",
    );
    expect(evaluateCheck(parseCheck("staged-absent r"), [rotated], same).verdict).toBe("pass");
    const committed = { ...rotated, staged: { evt_1: "active" } };
    expect(evaluateCheck(parseCheck("staged-absent r"), [committed], same).verdict).toBe("fail");
    const caps = parseCheck("capability-digests-equal");
    expect(evaluateCheck(caps, [], same).verdict).toBe("pass");
    const drift = { baseline: print(), candidate: print({ capability_digests: ["sha256:c1"] }) };
    expect(evaluateCheck(caps, [], drift).verdict).toBe("fail");
    expect(() => evaluateCheck(parseCheck("appended missing"), [], same)).toThrow("unknown step");
  });
});

describe("measurement helpers", () => {
  test("measureRoot reports active bytes, digest, prefix, archives, genesis and spool", () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-rehearsal-unit-"));
    roots.push(root);
    expect(measureRoot(root)).toEqual({
      active_bytes: 0,
      active_sha256: null,
      archives: 0,
      genesis_id: null,
      spool_files: [],
    });
    const ledger = join(root, ".harnery", "ledgers", "v3");
    mkdirSync(join(ledger, "spool"), { recursive: true });
    mkdirSync(join(root, ".harnery", "ledgers", "v3-archives", "epoch-a"), { recursive: true });
    writeFileSync(join(root, ".harnery", "ledgers", "v3-archives", "notes.txt"), "not an epoch");
    writeFileSync(join(ledger, "active.ndjson"), "first\nsecond\n");
    writeFileSync(
      join(ledger, "genesis.json"),
      JSON.stringify({ event: { payload: { genesis_id: "gex_9" } } }),
    );
    writeFileSync(join(ledger, "spool", "b.ready"), "");
    writeFileSync(join(ledger, "spool", "a.committed"), "");
    const measured = measureRoot(root, 6);
    expect(measured).toEqual({
      active_bytes: 13,
      active_sha256: sha256(Buffer.from("first\nsecond\n")),
      prefix_sha256: sha256(Buffer.from("first\n")),
      archives: 1,
      genesis_id: "gex_9",
      spool_files: ["a.committed", "b.ready"],
    });
    expect(measureRoot(root, 99).prefix_sha256).toBeNull();
  });

  test("stagedFate and parseStatus", () => {
    const fate = stagedFate(["evt_a", "evt_b", "evt_c"], '{"event_id":"evt_a"}\n', [
      "0001-evt_b-ff-gex_1.epoch-replaced",
      "0002-evt_a-ee.committed",
    ]);
    expect(fate).toEqual({
      evt_a: "active, spool.committed",
      evt_b: "spool.epoch-replaced",
      evt_c: "absent",
    });
    expect(parseStatus('{"state":"active","genesis":{"manifest_version":2}}\n', 0)).toEqual({
      state: "active",
      manifest_version: 2,
    });
    expect(parseStatus('{"error":{"code":"ledger_v3_status_failed","message":"bad"}}', 1)).toEqual({
      state: "error:ledger_v3_status_failed",
      reason: "bad",
    });
    expect(parseStatus("not json", 3).state).toBe("error:exit-3");
  });
});
