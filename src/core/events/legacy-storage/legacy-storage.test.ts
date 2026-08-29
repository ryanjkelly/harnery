import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJsonV3 } from "../v3/canonical.ts";
import { activateLegacyV1CanaryReplacement, writeLegacyV1Canary } from "./canary.ts";
import { verifyLegacyV1HardFence } from "./fence.ts";
import { inventoryLegacyV1Segments } from "./inventory.ts";
import { streamLegacyV1Rows } from "./reader.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const fence = join(root, ".harnery", "events.ndjson");
    if (existsSync(fence)) chmodSync(fence, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("sealed legacy V1 storage", () => {
  test("verifies the historical hard-fence schema and enumerates manual variants", async () => {
    const fixture = legacyFixture();
    const verified = await verifyLegacyV1HardFence(fixture.root);
    expect(verified.marker).toEqual({
      manifest_version: 1,
      kind: "v1_hard_path_fence",
      terminal_archive: ".harnery/events-2026-08-20.ndjson",
      terminal_digest: fixture.digest,
    });
    writeFileSync(
      join(fixture.harnery, "events-manual-backup.ndjson"),
      '{"at":"2026-01-01T00:00:00.000Z"}\n',
    );
    writeFileSync(join(fixture.harnery, "events-special.ndjson.gz"), "sealed-placeholder");
    expect((await inventoryLegacyV1Segments(fixture.root)).map(({ filename }) => filename)).toEqual(
      ["events-2026-08-20.ndjson", "events-manual-backup.ndjson", "events-special.ndjson.gz"],
    );
  });

  test("fails closed for an active file, writable fence, extra entry, and terminal mismatch", async () => {
    const activeRoot = fixtureRoot();
    mkdirSync(join(activeRoot, ".harnery"), { recursive: true });
    writeFileSync(join(activeRoot, ".harnery", "events.ndjson"), "active\n");
    await expect(verifyLegacyV1HardFence(activeRoot)).rejects.toThrow(
      "legacy_v1_active_file_present_or_fence_invalid",
    );

    const writable = legacyFixture();
    chmodSync(writable.fence, 0o700);
    await expect(verifyLegacyV1HardFence(writable.root)).rejects.toThrow(
      "legacy_v1_hard_fence_is_writable",
    );

    const extra = legacyFixture();
    chmodSync(extra.fence, 0o700);
    writeFileSync(join(extra.fence, "unexpected"), "x");
    chmodSync(extra.fence, 0o500);
    await expect(verifyLegacyV1HardFence(extra.root)).rejects.toThrow(
      "legacy_v1_hard_fence_not_exact",
    );

    const changed = legacyFixture();
    chmodSync(changed.terminal, 0o600);
    writeFileSync(changed.terminal, '{"at":"2026-08-21T00:00:00.000Z"}\n');
    await expect(verifyLegacyV1HardFence(changed.root)).rejects.toThrow(
      "legacy_v1_terminal_archive_digest_mismatch",
    );
  });

  test("shadow-compresses one canary with exact loose/gzip row parity and no replacement", async () => {
    const fixture = legacyFixture();
    const canary = await writeLegacyV1Canary({
      coord_root: fixture.root,
      source_filename: "events-2026-08-20.ndjson",
      output_directory: join(fixture.root, "shadow"),
      minimum_harnery_version: "0.36.0",
      created_at: "2026-08-29T00:00:00.000Z",
    });
    expect(canary).toMatchObject({ source_unchanged: true, replacement_enabled: false });
    const looseRows = await collectRows(fixture.terminal);
    const packedRows = await collectRows(canary.manifest_path);
    expect(packedRows).toEqual(looseRows);
    expect(readFileSync(fixture.terminal, "utf8")).toBe(fixture.contents);
    expect(() => activateLegacyV1CanaryReplacement()).toThrow(
      "legacy_v1_replacement_activation_disabled",
    );

    await expect(collectRows(canary.manifest_path, { max_decompressed_bytes: 4 })).rejects.toThrow(
      "legacy_v1_decompression_bound_exceeded",
    );
    let replaced = false;
    expect(
      await collectRows(canary.manifest_path, {
        fault(boundary, path) {
          if (boundary === "after_source_digest" && !replaced) {
            replaced = true;
            renameSync(path, `${path}.verified`);
            writeFileSync(path, gzipSync(Buffer.from('{"event":"evil"}\n')));
          }
        },
      }),
    ).toEqual(looseRows);
    writeFileSync(canary.payload_path, "corrupt");
    await expect(collectRows(canary.manifest_path)).rejects.toThrow(
      "legacy_v1_payload_length_mismatch",
    );
  });

  test("rejects an unterminated loose segment without yielding a complete result", async () => {
    const root = fixtureRoot();
    const segment = join(root, "events-manual.ndjson");
    writeFileSync(segment, '{"at":"2026-08-20T00:00:00.000Z"}');
    await expect(collectRows(segment)).rejects.toThrow(
      "legacy_v1_segment_unterminated_or_truncated",
    );
  });

  test("streams an existing loose gzip segment without a replacement manifest", async () => {
    const root = fixtureRoot();
    const segment = join(root, "events-manual.ndjson.gz");
    writeFileSync(
      segment,
      gzipSync(Buffer.from('{"at":"2026-08-20T00:00:00.000Z","event":"safe"}\n')),
    );
    expect(await collectRows(segment)).toEqual([
      '{"at":"2026-08-20T00:00:00.000Z","event":"safe"}',
    ]);
  });

  test("rejects symlinks and keeps streaming the opened file when its pathname is replaced", async () => {
    const root = fixtureRoot();
    const outside = join(root, "outside.ndjson");
    writeFileSync(outside, '{"event":"outside"}\n');
    const symlink = join(root, "events-symlink.ndjson");
    symlinkSync(outside, symlink);
    await expect(collectRows(symlink)).rejects.toThrow("legacy_v1_segment_not_regular");

    const fixture = legacyFixture();
    const canary = await writeLegacyV1Canary({
      coord_root: fixture.root,
      source_filename: "events-2026-08-20.ndjson",
      output_directory: join(fixture.root, "shadow"),
      minimum_harnery_version: "0.36.0",
      created_at: "2026-08-29T00:00:00.000Z",
    });
    renameSync(canary.payload_path, `${canary.payload_path}.outside`);
    symlinkSync(`${canary.payload_path}.outside`, canary.payload_path);
    await expect(collectRows(canary.manifest_path)).rejects.toThrow(
      "legacy_v1_payload_not_regular",
    );

    const segment = join(root, "events-race.ndjson");
    writeFileSync(segment, '{"event":"safe"}\n');
    let replaced = false;
    const rows = await collectRows(segment, {
      fault(boundary, path) {
        if (boundary === "after_source_digest" && !replaced) {
          replaced = true;
          renameSync(path, `${path}.verified`);
          writeFileSync(path, '{"event":"evil"}\n');
        }
      },
    });
    expect(rows).toEqual(['{"event":"safe"}']);
  });

  test("accounts for an exact 17-file sealed census including manual and gzip variants", async () => {
    const fixture = legacyFixture();
    for (let index = 1; index <= 15; index += 1) {
      writeFileSync(
        join(fixture.harnery, `events-manual-${String(index).padStart(2, "0")}.ndjson`),
        `{"at":"2026-08-${String(index).padStart(2, "0")}T00:00:00.000Z","event":"safe-${index}"}\n`,
      );
    }
    writeFileSync(
      join(fixture.harnery, "events-backup.ndjson.gz"),
      gzipSync(Buffer.from('{"at":"2026-08-19T00:00:00.000Z","event":"safe-backup"}\n')),
    );
    await verifyLegacyV1HardFence(fixture.root);
    const inventory = await inventoryLegacyV1Segments(fixture.root);
    expect(inventory).toHaveLength(17);
    expect(inventory.some(({ filename }) => filename === "events-backup.ndjson.gz")).toBe(true);
    let rows = 0;
    for (const segment of inventory) rows += (await collectRows(segment.path)).length;
    expect(rows).toBe(18);
  });
});

function legacyFixture(): {
  root: string;
  harnery: string;
  fence: string;
  terminal: string;
  digest: `sha256:${string}`;
  contents: string;
} {
  const root = fixtureRoot();
  const harnery = join(root, ".harnery");
  const fence = join(harnery, "events.ndjson");
  mkdirSync(fence, { recursive: true, mode: 0o700 });
  const terminal = join(harnery, "events-2026-08-20.ndjson");
  const contents = [
    '{"at":"2026-08-20T00:00:00.000Z","event":"safe-start"}',
    '{"at":"2026-08-20T00:01:00.000Z","event":"safe-end"}',
    "",
  ].join("\n");
  writeFileSync(terminal, contents, { mode: 0o400 });
  const digest = sha(Buffer.from(contents));
  const marker = {
    manifest_version: 1,
    kind: "v1_hard_path_fence",
    terminal_archive: ".harnery/events-2026-08-20.ndjson",
    terminal_digest: digest,
  };
  const markerPath = join(fence, "V1-SEALED.json");
  writeFileSync(markerPath, canonicalJsonV3(marker), { mode: 0o400 });
  chmodSync(markerPath, 0o400);
  chmodSync(fence, 0o500);
  return { root, harnery, fence, terminal, digest, contents };
}

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v1-storage-test-"));
  roots.push(root);
  return root;
}

async function collectRows(
  path: string,
  limits: Parameters<typeof streamLegacyV1Rows>[1] = {},
): Promise<string[]> {
  const rows: string[] = [];
  for await (const row of streamLegacyV1Rows(path, limits)) rows.push(row.bytes.toString("utf8"));
  return rows;
}

function sha(value: Buffer): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
