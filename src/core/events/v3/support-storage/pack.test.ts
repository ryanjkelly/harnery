import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJsonV3 } from "../canonical.ts";
import {
  assertEventV3SupportPackAuthority,
  type EventV3SupportPackRecord,
  logicalEntriesDigestV3,
  validateEventV3SupportPackRecord,
} from "./pack-contract.ts";
import {
  readEventV3SupportPackManifest,
  unpackEventV3SupportPack,
  validateEventV3SupportPack,
} from "./pack-reader.ts";
import { writeEventV3SupportPack } from "./pack-writer.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Event Ledger V3 support-pack protocol", () => {
  test("streams deterministic packs and explicitly reconstructs exact source bytes", async () => {
    const root = fixtureRoot();
    mkdirSync(join(root, "authority", "diagnostics"), { recursive: true });
    mkdirSync(join(root, "authority", "authority-outbox"), { recursive: true });
    writeFileSync(join(root, "authority", "diagnostics", "alpha.json"), '{"code":"safe_alpha"}\n');
    writeFileSync(
      join(root, "authority", "authority-outbox", "tx.committed.json"),
      '{"state":"committed"}\n',
    );
    const input = {
      authority_root: join(root, "authority"),
      output_directory: join(root, "shadow"),
      root_id: "root_fixture",
      genesis_id: "gen_fixture",
      verification_mode: "active-frozen-files" as const,
      sources: [
        {
          relative_path: "diagnostics/alpha.json",
          family: "diagnostic" as const,
          recorded_at: "2026-08-20T00:00:00.000Z",
          diagnostic_category: "join",
          diagnostic_reason: "safe_alpha",
        },
        {
          relative_path: "authority-outbox/tx.committed.json",
          family: "authority-committed" as const,
          recorded_at: "2026-08-21T00:00:00.000Z",
        },
      ],
      minimum_harnery_version: "0.36.0",
      created_at: "2026-08-29T00:00:00.000Z",
    };
    const first = await writeEventV3SupportPack(input);
    const validated = await validateEventV3SupportPack(first.manifest_path);
    expect(validated.records.map(({ path }) => path)).toEqual([
      "authority-outbox/tx.committed.json",
      "diagnostics/alpha.json",
    ]);
    expect(first.manifest.entries.by_family).toMatchObject({
      diagnostic: 1,
      "authority-committed": 1,
    });
    expect(first.manifest.entries.by_diagnostic_reason).toEqual({ safe_alpha: 1 });
    expect(readFileSync(join(root, "authority", "diagnostics", "alpha.json"), "utf8")).toBe(
      '{"code":"safe_alpha"}\n',
    );
    const out = join(root, "unpacked");
    expect(await unpackEventV3SupportPack(first.manifest_path, out)).toMatchObject({ files: 2 });
    expect(readFileSync(join(out, "diagnostics", "alpha.json"), "utf8")).toBe(
      '{"code":"safe_alpha"}\n',
    );
    await expect(unpackEventV3SupportPack(first.manifest_path, out)).rejects.toThrow(
      "event_v3_support_unpack_destination_exists",
    );

    const second = await writeEventV3SupportPack({
      ...input,
      output_directory: join(root, "shadow-2"),
    });
    expect(readFileSync(second.payload_path)).toEqual(readFileSync(first.payload_path));
    expect(second.manifest.pack_id).toBe(first.manifest.pack_id);
  });

  test("rejects unsafe paths, duplicates, length and digest mismatches", async () => {
    expect(() =>
      validateEventV3SupportPackRecord({
        path: "../escape",
        bytes: 1,
        digest: sha(Buffer.from("x")),
        content_base64: "eA==",
      }),
    ).toThrow();
    expect(() =>
      validateEventV3SupportPackRecord({
        path: "diagnostics\\escape",
        bytes: 1,
        digest: sha(Buffer.from("x")),
        content_base64: "eA==",
      }),
    ).toThrow();

    const duplicate = rawPack([
      record("diagnostics/a.json", "a"),
      record("diagnostics/a.json", "a"),
    ]);
    await expect(validateEventV3SupportPack(duplicate)).rejects.toThrow(
      "event_v3_support_duplicate_path",
    );
    const wrongLength = rawPack([{ ...record("diagnostics/a.json", "a"), bytes: 2 }]);
    await expect(validateEventV3SupportPack(wrongLength)).rejects.toThrow(
      "event_v3_support_record_length_mismatch",
    );
    const wrongDigest = rawPack([
      { ...record("diagnostics/a.json", "a"), digest: sha(Buffer.from("b")) },
    ]);
    await expect(validateEventV3SupportPack(wrongDigest)).rejects.toThrow(
      "event_v3_support_record_digest_mismatch",
    );
  });

  test("fails closed on truncation, trailing records, payload tampering, and decompression bounds", async () => {
    const truncated = rawPack([record("diagnostics/a.json", "a")], { terminalNewline: false });
    await expect(validateEventV3SupportPack(truncated)).rejects.toThrow(
      "event_v3_support_payload_truncated_or_trailing",
    );
    const trailing = rawPack([record("diagnostics/a.json", "a")], { extra: "\n" });
    await expect(validateEventV3SupportPack(trailing)).rejects.toThrow(
      "event_v3_support_trailing_data",
    );
    const concatenated = rawPack([record("diagnostics/a.json", "a")], {
      payloadSuffix: gzipSync(Buffer.alloc(0)),
    });
    await expect(validateEventV3SupportPack(concatenated)).rejects.toThrow(
      "event_v3_support_gzip_trailing_data",
    );
    const bounded = rawPack([record("diagnostics/a.json", "0123456789")]);
    await expect(
      validateEventV3SupportPack(bounded, { max_decompressed_bytes: 8 }),
    ).rejects.toThrow("event_v3_support_decompression_bound_exceeded");
    const tampered = rawPack([record("diagnostics/a.json", "a")]);
    const manifest = await readEventV3SupportPackManifest(tampered);
    writeFileSync(join(join(tampered, ".."), manifest.payload.path), "not-gzip");
    await expect(validateEventV3SupportPack(tampered)).rejects.toThrow(
      "event_v3_support_payload_length_mismatch",
    );
  });

  test("binds manifests to the exact root, genesis, and verification mode", async () => {
    const path = rawPack([record("diagnostics/a.json", "a")]);
    const manifest = await readEventV3SupportPackManifest(path);
    expect(() =>
      assertEventV3SupportPackAuthority(manifest, {
        root_id: "wrong",
        genesis_id: "gen_fixture",
      }),
    ).toThrow("event_v3_support_pack_wrong_root_authority");
    expect(() =>
      assertEventV3SupportPackAuthority(manifest, {
        root_id: "root_fixture",
        genesis_id: "wrong",
      }),
    ).toThrow("event_v3_support_pack_wrong_genesis_authority");
  });

  test("rolls back a partial unpack when final logical validation fails", async () => {
    const invalid = rawPack([record("diagnostics/a.json", "safe")], {
      manifestLogicalDigest: `sha256:${"f".repeat(64)}`,
    });
    const destination = join(fixtureRoot(), "new-destination");
    await expect(unpackEventV3SupportPack(invalid, destination)).rejects.toThrow(
      "event_v3_support_logical_digest_mismatch",
    );
    expect(existsSync(destination)).toBe(false);
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-pack-test-"));
  roots.push(root);
  return root;
}

function record(path: string, content: string): EventV3SupportPackRecord {
  const bytes = Buffer.from(content);
  return {
    path,
    bytes: bytes.length,
    digest: sha(bytes),
    content_base64: bytes.toString("base64"),
  };
}

function rawPack(
  records: EventV3SupportPackRecord[],
  options: {
    terminalNewline?: boolean;
    extra?: string;
    payloadSuffix?: Buffer;
    manifestLogicalDigest?: `sha256:${string}`;
  } = {},
): string {
  const root = fixtureRoot();
  const directory = join(root, "pack");
  mkdirSync(directory, { recursive: true });
  chmodSync(directory, 0o700);
  const entries = records.map(({ path, bytes, digest }) => ({ path, bytes, digest }));
  const logicalDigest = logicalEntriesDigestV3(entries);
  const packId = "vsp_00000000000000000000000000000000" as const;
  const text = `${records.map((value) => canonicalJsonV3(value)).join("\n")}${
    options.terminalNewline === false ? "" : "\n"
  }${options.extra ?? ""}`;
  const payload = Buffer.concat([
    gzipSync(Buffer.from(text)),
    options.payloadSuffix ?? Buffer.alloc(0),
  ]);
  const payloadName = `${packId}.ndjson.gz`;
  writeFileSync(join(directory, payloadName), payload, { mode: 0o600 });
  const manifest = {
    format: "harnery-event-v3-support-pack",
    format_version: 1,
    pack_id: packId,
    authority: {
      root_id: "root_fixture",
      genesis_id: "gen_fixture",
      verification_mode: "active-frozen-files",
      source_files_digest: options.manifestLogicalDigest ?? logicalDigest,
    },
    scope: {
      families: ["diagnostic"],
      minimum_recorded_at: null,
      maximum_recorded_at: null,
    },
    entries: {
      count: records.length,
      uncompressed_bytes: records.reduce((sum, value) => sum + value.bytes, 0),
      logical_entries_digest: options.manifestLogicalDigest ?? logicalDigest,
      by_family: {
        diagnostic: records.length,
        "session-tee": 0,
        "authority-ready": 0,
        "authority-committed": 0,
        "authority-residue": 0,
      },
      by_diagnostic_category: {},
      by_diagnostic_reason: {},
    },
    payload: {
      algorithm: "gzip",
      path: payloadName,
      bytes: payload.length,
      digest: sha(payload),
    },
    minimum_harnery_version: "0.36.0",
    created_at: "2026-08-29T00:00:00.000Z",
  };
  const manifestPath = join(directory, `${packId}.manifest.json`);
  writeFileSync(manifestPath, `${canonicalJsonV3(manifest)}\n`, { mode: 0o600 });
  return manifestPath;
}

function sha(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
