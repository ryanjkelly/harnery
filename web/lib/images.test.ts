/**
 * Locks the bounded tail read behind the /images feed. `readImageCaptures` used
 * to `readFileSync` the whole events.ndjson and, in a try/catch, silently return
 * [] on failure — so once the append-only ledger passed V8's ~512MB max string
 * length the feed went blank (produced screenshots stopped surfacing) with no
 * error. It now rides `scanEventsTail`. Invariants: image.captured events are
 * grouped by content hash newest-first, touches accumulate per image, and the
 * distinct-image `limit` is honoured.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJsonV2, sha256V2 } from "../../src/core/events/v2/canonical.ts";
import { adapterCapabilityProfileDigestV2 } from "../../src/core/events/v2/capabilities.ts";
import {
  buildCandidateGenesisManifestV2,
  EVENT_V2_GENESIS_MANIFEST,
  repairEventV2ControlPair,
} from "../../src/core/events/v2/control.ts";
import { loadOrCreateFingerprintKeyStoreV2 } from "../../src/core/events/v2/fingerprint-keys.ts";
import { EVENT_V2_SCHEMA_DIGEST } from "../../src/core/events/v2/generated.ts";
import { __resetCoordRootCache } from "./coord-reader.ts";
import { readImageCaptures } from "./images.ts";

function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "harn-img-"));
  mkdirSync(path.join(root, ".harnery"), { recursive: true });
  return root;
}

function captureLine(opts: {
  seq: number;
  hash: string;
  role?: "viewed" | "produced";
  instanceId?: string;
  ts: string;
}): string {
  const { seq, hash, role = "produced", instanceId = "sess-1", ts } = opts;
  return JSON.stringify({
    schema_version: 1,
    event_id: `01img-${seq}`,
    event_type: "image.captured",
    ts,
    instance_id: instanceId,
    session_id: instanceId,
    adapter: "claude-code",
    source: "test",
    data: {
      hash,
      ext: "png",
      bytes: 1000 + seq,
      role,
      source_path: `/tmp/shot-${seq}.png`,
      tool_name: "Bash",
      intent: `screenshot ${seq}`,
    },
  });
}

const NON_IMAGE = JSON.stringify({
  schema_version: 1,
  event_id: "01noise",
  event_type: "tool.pre_use",
  ts: "2026-07-07T00:00:00Z",
  instance_id: "sess-1",
  session_id: "sess-1",
  adapter: "claude-code",
  source: "test",
  data: { tool_name: "Bash" },
});

function withRoot(lines: string[], fn: () => void): void {
  const root = freshRoot();
  writeFileSync(path.join(root, ".harnery", "events.ndjson"), `${lines.join("\n")}\n`, "utf8");
  const prev = process.env.HARNERY_COORD_ROOT;
  process.env.HARNERY_COORD_ROOT = root;
  __resetCoordRootCache();
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.HARNERY_COORD_ROOT;
    else process.env.HARNERY_COORD_ROOT = prev;
    __resetCoordRootCache();
  }
}

function openCandidateGate(root: string): void {
  const keyStore = loadOrCreateFingerprintKeyStoreV2(root);
  const manifest = buildCandidateGenesisManifestV2({
    profile: {
      initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
      contract_source_digest: sha256V2("contract"),
      harnery_commit: "fixture",
      host_repository_commit: "fixture",
      producer_build_ids: ["build_fixture"],
      adapter_capability_profile_digests: [
        `sha256:${adapterCapabilityProfileDigestV2("claude-code").slice(4)}`,
      ],
      config_digest: sha256V2("config"),
      canonicalizer_version: "harnery-jcs-nfc-v1",
      fingerprint_version: "hmac-sha256-v1",
      privacy_key_epoch: keyStore.active_epoch_id,
      v1_terminal_digest: sha256V2("v1"),
      v1_terminal_bytes: 1,
      v1_terminal_rows: 1,
      candidate_created_at: "2026-08-16T18:00:00.000Z",
    },
    root_id: "root_fixture",
    instance_id: "inst_cutover",
    producer: {
      producer_id: "prd_cutover",
      boot_id: "boot_cutover",
      sequence: 1,
      build_id: "build_fixture",
      platform: "linux",
    },
  });
  const manifestPath = path.join(root, EVENT_V2_GENESIS_MANIFEST);
  mkdirSync(path.dirname(manifestPath), { recursive: true, mode: 0o700 });
  writeFileSync(manifestPath, `${canonicalJsonV2(manifest)}\n`, { mode: 0o600 });
  expect(repairEventV2ControlPair(root).state).toBe("candidate");
}

describe("readImageCaptures", () => {
  test("groups touches by hash, images newest-first, touches newest-first", () => {
    const lines = [
      captureLine({ seq: 0, hash: "a".repeat(64), role: "produced", ts: "2026-07-07T00:00:01Z" }),
      NON_IMAGE,
      captureLine({ seq: 1, hash: "b".repeat(64), role: "produced", ts: "2026-07-07T00:00:02Z" }),
      // second touch of image A, newer, by a different agent + role
      captureLine({
        seq: 2,
        hash: "a".repeat(64),
        role: "viewed",
        instanceId: "sess-2",
        ts: "2026-07-07T00:00:03Z",
      }),
    ];
    withRoot(lines, () => {
      const resp = readImageCaptures();
      expect(resp.meta.distinct).toBe(2);
      expect(resp.meta.total_touches).toBe(3);
      // A's latest touch (00:03) is newer than B's (00:02), so A sorts first.
      expect(resp.images.map((i) => i.hash)).toEqual(["a".repeat(64), "b".repeat(64)]);
      const imgA = resp.images[0]!;
      expect(imgA.touch_count).toBe(2);
      expect(imgA.roles.sort()).toEqual(["produced", "viewed"]);
      // touches newest-first
      expect(imgA.touches.map((t) => t.ts)).toEqual([
        "2026-07-07T00:00:03Z",
        "2026-07-07T00:00:01Z",
      ]);
    });
  });

  test("honours the distinct-image limit (newest kept)", () => {
    const lines = [0, 1, 2, 3, 4].map((s) =>
      captureLine({
        seq: s,
        hash: String(s).repeat(64).slice(0, 64),
        ts: `2026-07-07T00:00:0${s}Z`,
      }),
    );
    withRoot(lines, () => {
      const resp = readImageCaptures({ limit: 2 });
      expect(resp.images.length).toBe(2);
      // Newest two by ts: seq 4 then seq 3.
      expect(resp.images.map((i) => i.hash)).toEqual(["4".repeat(64), "3".repeat(64)]);
    });
  });

  test("empty feed when the stream holds no image events", () => {
    withRoot([NON_IMAGE, NON_IMAGE], () => {
      const resp = readImageCaptures();
      expect(resp.images).toEqual([]);
      expect(resp.meta.distinct).toBe(0);
    });
  });

  test("candidate gate returns an explicit unavailable V2 feed without reading fenced V1", () => {
    const root = freshRoot();
    writeFileSync(
      path.join(root, ".harnery", "events.ndjson"),
      `${captureLine({ seq: 1, hash: "a".repeat(64), ts: "2026-07-07T00:00:01Z" })}\n`,
      "utf8",
    );
    openCandidateGate(root);
    const previous = process.env.HARNERY_COORD_ROOT;
    process.env.HARNERY_COORD_ROOT = root;
    __resetCoordRootCache();
    try {
      const response = readImageCaptures();
      expect(response.images).toEqual([]);
      expect(response.meta).toMatchObject({
        source: "v2",
        authoritative: false,
        distinct: 0,
        total_touches: 0,
      });
      expect(response.meta.reason).toContain("do not yet expose");
    } finally {
      if (previous === undefined) delete process.env.HARNERY_COORD_ROOT;
      else process.env.HARNERY_COORD_ROOT = previous;
      __resetCoordRootCache();
    }
  });
});
