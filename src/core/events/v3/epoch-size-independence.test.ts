import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventV3Fixture } from "../../../../tests/helpers/event-v3.ts";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { canonicalJsonV3, sha256V3 } from "./canonical.ts";
import {
  EVENT_V3_ACTIVATION_MANIFEST,
  type EventV3ControlState,
  readEventV3ControlState,
} from "./control.ts";
import { resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";
import { eventV3Paths } from "./writer.ts";

/**
 * A hook is a cold one-shot process, so what it costs is what one process pays
 * to resolve the control state before it records anything. That cost used to
 * scale with the whole epoch: a 100 MB segment made every hook read and
 * validate 100 MB. This suite measures the cost in separate processes at 1 MiB
 * and at 40 MiB, in both control states, and holds the ratio near one.
 */
const SMALL_BYTES = 1024 * 1024;
const LARGE_BYTES = 40 * 1024 * 1024;
const MAX_RATIO = 1.2;
const PROBE_RUNS = 7;

type ControlStateName = EventV3ControlState["state"];

interface ProbeReceipt {
  state: ControlStateName;
  ms: number;
  rss: number;
  rchar?: number;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 hook receipts are epoch-size independent", () => {
  test("an active epoch costs the same at 1 MiB and at 40 MiB", () => {
    const small = probe(activeRootOfSize(SMALL_BYTES), "active");
    const large = probe(activeRootOfSize(LARGE_BYTES), "active");
    expectSizeIndependent("active", small, large);
  });

  test("a candidate epoch costs the same at 1 MiB and at 40 MiB", () => {
    const small = probe(candidateRootOfSize(SMALL_BYTES), "candidate");
    const large = probe(candidateRootOfSize(LARGE_BYTES), "candidate");
    expectSizeIndependent("candidate", small, large);
  });

  test("a stranded 40 MiB candidate is repaired and rotated at the next route resolution", () => {
    const root = candidateRootOfSize(LARGE_BYTES);
    const strandedBytes = statSync(eventV3Paths(root).active).size;
    expect(strandedBytes).toBeGreaterThanOrEqual(LARGE_BYTES);
    expect(readEventV3ControlState(root).state).toBe("candidate");

    // No pinned threshold: the shipped 32 MiB default has to fire on its own.
    expect(resolveLiveEventLedgerRouteV3(root)).toMatchObject({ state: "v3", mode: "active" });

    const archived = archives(root);
    expect(archived).toHaveLength(1);
    const archivedActive = join(
      root,
      ".harnery",
      "ledgers",
      "v3-archives",
      archived[0]!,
      "active.ndjson",
    );
    // The epoch was repaired first, so the archive carries its activation.
    expect(statSync(archivedActive).size).toBeGreaterThanOrEqual(strandedBytes);
    expect(
      existsSync(join(root, ".harnery", "ledgers", "v3-archives", archived[0]!, "activation.json")),
    ).toBeTrue();
    expect(statSync(eventV3Paths(root).active).size).toBeLessThan(SMALL_BYTES);

    const receipt = probe(root, "active");
    expect(receipt.state).toBe("active");
  });
});

function expectSizeIndependent(label: string, small: ProbeReceipt, large: ProbeReceipt): void {
  const durationRatio = large.ms / small.ms;
  const rssRatio = large.rss / small.rss;
  const rcharRatio =
    small.rchar !== undefined && large.rchar !== undefined ? large.rchar / small.rchar : undefined;
  console.log(
    `${label} receipt: 1 MiB ${small.ms.toFixed(1)} ms / ${mib(small.rss)} MiB RSS / ${bytes(small.rchar)} read; ` +
      `40 MiB ${large.ms.toFixed(1)} ms / ${mib(large.rss)} MiB RSS / ${bytes(large.rchar)} read; ` +
      `ratios duration ${durationRatio.toFixed(2)}, rss ${rssRatio.toFixed(2)}` +
      (rcharRatio === undefined ? "" : `, bytes-read ${rcharRatio.toFixed(2)}`),
  );
  expect(small.state).toBe(large.state);
  expect(durationRatio).toBeLessThan(MAX_RATIO);
  expect(rssRatio).toBeLessThan(MAX_RATIO);
  if (rcharRatio !== undefined) {
    expect(rcharRatio).toBeLessThan(MAX_RATIO);
    // The point of the witness: the 40 MiB epoch is never read.
    expect(large.rchar!).toBeLessThan(4 * 1024 * 1024);
  }
}

/**
 * Measure one cold process, the way a hook runs, and keep the fastest run so
 * unrelated machine load cannot decide the comparison.
 */
function probe(root: string, expectedState: ControlStateName): ProbeReceipt {
  // Publish the state witness first: this is the steady state every hook after
  // the first one meets.
  expect(readEventV3ControlState(root).state).toBe(expectedState);
  const probePath = join(root, "receipt-probe.ts");
  writeFileSync(probePath, probeSource(root), { mode: 0o600 });
  const receipts: ProbeReceipt[] = [];
  for (let run = 0; run < PROBE_RUNS; run += 1) {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", probePath],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = result.stdout.toString().trim();
    if (!result.success) {
      throw new Error(`receipt probe failed: ${result.stderr.toString().trim() || stdout}`);
    }
    const receipt = JSON.parse(stdout) as ProbeReceipt;
    expect(receipt.state).toBe(expectedState);
    receipts.push(receipt);
  }
  receipts.sort((left, right) => left.ms - right.ms);
  return receipts[0]!;
}

function probeSource(root: string): string {
  const controlModule = join(import.meta.dir, "control.ts");
  return `import { readFileSync } from "node:fs";
import { readEventV3ControlState } from ${JSON.stringify(controlModule)};

function charactersRead(): number | undefined {
  try {
    const io = readFileSync("/proc/self/io", "utf8");
    const match = /^rchar:\\s*(\\d+)$/m.exec(io);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

const readBefore = charactersRead();
const startedAt = process.hrtime.bigint();
const control = readEventV3ControlState(${JSON.stringify(root)});
const elapsed = process.hrtime.bigint() - startedAt;
const readAfter = charactersRead();
console.log(
  JSON.stringify({
    state: control.state,
    ms: Number(elapsed) / 1e6,
    rss: process.memoryUsage().rss,
    ...(readBefore !== undefined && readAfter !== undefined
      ? { rchar: readAfter - readBefore }
      : {}),
  }),
);
`;
}

function activeRootOfSize(targetBytes: number): string {
  const root = freshRoot();
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("config"),
    approvalRecordId: "fixture-size-independence",
    now: () => new Date("2026-09-02T09:57:40.996Z"),
  });
  padEpoch(root, targetBytes);
  return root;
}

/** A stranded candidate that kept growing, which is how one reached 100 MB. */
function candidateRootOfSize(targetBytes: number): string {
  const root = activeRootOfSize(0);
  const active = eventV3Paths(root).active;
  const genesisRow = readFileSync(active, "utf8").split("\n")[0];
  writeFileSync(active, `${genesisRow}\n`, "utf8");
  unlinkSync(join(root, EVENT_V3_ACTIVATION_MANIFEST));
  // Read the stranded epoch before it grows. A real hook meets it in a fresh
  // process; in one long-lived process the reader would otherwise resume from
  // its cached view of the pre-crash bytes.
  if (readEventV3ControlState(root).state !== "candidate") {
    throw new Error("expected a stranded candidate epoch");
  }
  padEpoch(root, targetBytes);
  return root;
}

/**
 * Append valid history in bulk.
 *
 * Every row is canonical and carries its own event id, producer sequence, and
 * clock reading, so the epoch validates completely; going through the writer
 * for tens of thousands of rows would cost an append lease and a full
 * revalidation each time.
 */
function padEpoch(root: string, targetBytes: number): void {
  const active = eventV3Paths(root).active;
  let size = statSync(active).size;
  if (size >= targetBytes) return;
  let sequence = 0;
  let pending: string[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    appendFileSync(active, `${pending.join("\n")}\n`, "utf8");
    pending = [];
  };
  while (size < targetBytes) {
    sequence += 1;
    const event = eventV3Fixture("ledger.comparability_advanced", sequence) as Record<
      string,
      Record<string, unknown> & Record<string, never>
    > as unknown as {
      event_id: string;
      payload: { reason: string };
      producer: { producer_id: string; boot_id: string; sequence: number };
      time: { clock_id: string; observed_at: string; recorded_at: string };
    };
    event.event_id = `evt_00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
    event.producer.producer_id = "prd_padding";
    event.producer.boot_id = "boot_padding";
    event.producer.sequence = sequence;
    event.payload.reason = "padding".padEnd(64, "-");
    event.time.clock_id = "clk_00000000-0000-7000-8000-0000000000ff";
    const at = new Date(Date.parse("2026-09-02T10:00:00.000Z") + sequence).toISOString();
    event.time.observed_at = at;
    event.time.recorded_at = at;
    const row = canonicalJsonV3(event);
    pending.push(row);
    size += Buffer.byteLength(row) + 1;
    if (pending.length >= 2000) flush();
  }
  flush();
}

function archives(root: string): string[] {
  const directory = join(root, ".harnery", "ledgers", "v3-archives");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function mib(value: number): string {
  return (value / (1024 * 1024)).toFixed(0);
}

function bytes(value: number | undefined): string {
  return value === undefined ? "n/a" : `${(value / 1024).toFixed(0)} KiB`;
}

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-size-"));
  roots.push(root);
  return root;
}
