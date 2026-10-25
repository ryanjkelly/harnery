import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeEventLedgerV3 } from "./bootstrap.ts";
import { sha256V3 } from "./canonical.ts";
import { EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH } from "./control-witness.ts";
import { recordLiveHookSignalV3, resolveLiveEventLedgerRouteV3 } from "./live-routing.ts";

const roots: string[] = [];
const readerPath = join(import.meta.dir, "reader.ts");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("event ledger V3 witnessed cold read", () => {
  test("returns exactly what a full validation returns", () => {
    const root = populatedRoot();
    expect(existsSync(witnessPath(root))).toBeTrue();
    const witnessed = coldRead(root);

    unlinkSync(witnessPath(root));
    const full = coldRead(root);

    expect(witnessed.complete).toBeTrue();
    expect(witnessed.events).toBeGreaterThan(2);
    expect(witnessed).toEqual(full);
  });

  test("falls back to full validation after a corrupt append", () => {
    const root = populatedRoot();
    appendFileSync(activePath(root), "{}\n", "utf8");

    const read = coldRead(root);
    expect(read.complete).toBeFalse();
    expect(read.codes).toContain("unsupported_major");
  });

  test("falls back to full validation after a same-size rewrite", () => {
    const root = populatedRoot();
    const active = activePath(root);
    const valid = readFileSync(active, "utf8");
    const corrupt = valid.replace('"major":3', '"major":4');
    expect(Buffer.byteLength(corrupt)).toBe(Buffer.byteLength(valid));
    writeFileSync(active, corrupt, "utf8");
    const changedAt = new Date(Date.now() + 1_000);
    utimesSync(active, changedAt, changedAt);

    const read = coldRead(root);
    expect(read.complete).toBeFalse();
    expect(read.codes).toContain("unsupported_major");
  });

  test("ignores a forged witness", () => {
    const root = populatedRoot();
    const expected = coldRead(root);
    const path = witnessPath(root);
    const valid = readFileSync(path, "utf8");
    const forged = valid.replace(/sha256:[a-f0-9]{64}/, `sha256:${"0".repeat(64)}`);
    expect(forged).not.toBe(valid);
    writeFileSync(path, forged, { mode: 0o600 });

    expect(coldRead(root)).toEqual(expected);
  });
});

interface ColdRead {
  complete: boolean;
  events: number;
  codes: string[];
  digest: string;
}

/** A fresh process has no in-memory read cache, so this exercises the cold path. */
function coldRead(root: string): ColdRead {
  const script = `
    const { readLedgerV3 } = await import(${JSON.stringify(readerPath)});
    const read = readLedgerV3(${JSON.stringify(root)});
    console.log(JSON.stringify({
      complete: read.complete,
      events: read.events.length,
      codes: read.diagnostics.map((diagnostic) => diagnostic.code),
      result: read,
    }, (_key, value) => (typeof value === "bigint" ? value.toString() : value)));
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script]);
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  const parsed = JSON.parse(child.stdout.toString()) as Omit<ColdRead, "digest"> & {
    result: unknown;
  };
  return {
    complete: parsed.complete,
    events: parsed.events,
    codes: parsed.codes,
    digest: sha256V3(JSON.stringify(parsed.result)),
  };
}

function populatedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-reader-witness-"));
  roots.push(root);
  initializeEventLedgerV3({
    coordRoot: root,
    harneryBuild: "fixture",
    hostBuild: "fixture-host",
    configDigest: sha256V3("fixture-config"),
    approvalRecordId: "fixture-reader-witness",
    now: () => new Date("2026-08-30T09:00:00.000Z"),
  });
  const route = resolveLiveEventLedgerRouteV3(root);
  if (route.state !== "v3") throw new Error("expected V3 route");
  const recorded = recordLiveHookSignalV3({
    coordRoot: root,
    route,
    eventName: "session-start",
    adapter: "codex",
    instanceId: "agent-Witness",
    payload: { session_id: "witness-session", raw: {} },
  });
  if (recorded.state !== "recorded") throw new Error(`expected recorded, got ${recorded.state}`);
  return root;
}

function witnessPath(root: string): string {
  return join(root, EVENT_V3_CONTROL_WITNESS_RELATIVE_PATH);
}

function activePath(root: string): string {
  return join(root, ".harnery", "ledgers", "v3", "active.ndjson");
}
