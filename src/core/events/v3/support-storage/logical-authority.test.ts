import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestEventV3AuthorityDirectoryV3 } from "../reader.ts";
import {
  digestEventV3LogicalAuthority,
  iterateEventV3LogicalAuthority,
} from "./logical-authority.ts";
import { writeEventV3SupportPack } from "./pack-writer.ts";
import { verifyEventV3RecoveryBoundArchive } from "./recovery.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Event Ledger V3 logical authority", () => {
  test("preserves the physical digest across mixed loose and packed sources", async () => {
    const authority = authorityFixture();
    const before = digestEventV3AuthorityDirectoryV3(authority);
    await writePack(authority, ["diagnostics/a.json", "diagnostics/b.json"]);
    expect(await digestEventV3LogicalAuthority(authority)).toBe(before);
    unlinkSync(join(authority, "diagnostics", "b.json"));
    const view = await iterateEventV3LogicalAuthority(authority);
    expect(view.quarantined_packs).toEqual([]);
    expect(view.entries.map(({ path }) => path)).toEqual([
      "active.ndjson",
      "diagnostics/a.json",
      "diagnostics/b.json",
    ]);
    expect(await digestEventV3LogicalAuthority(authority)).toBe(before);
  });

  test("quarantines a loose-pack mismatch and refuses a recovery digest", async () => {
    const authority = authorityFixture();
    const before = digestEventV3AuthorityDirectoryV3(authority);
    await writePack(authority, ["diagnostics/a.json", "diagnostics/b.json"]);
    writeFileSync(join(authority, "diagnostics", "a.json"), '{"code":"changed"}\n');
    const view = await iterateEventV3LogicalAuthority(authority);
    expect(view.quarantined_packs[0]?.reason).toBe("loose_pack_digest_conflict:diagnostics/a.json");
    await expect(digestEventV3LogicalAuthority(authority)).rejects.toThrow(
      "event_v3_logical_authority_has_quarantined_pack",
    );
    await expect(
      verifyEventV3RecoveryBoundArchive({
        authority_root: authority,
        expected_authority_digest: before,
        recovery_receipt_id: "rcv_fixture",
      }),
    ).rejects.toThrow("event_v3_support_recovery_pack_quarantined");
  });

  test("fails closed when two packs claim one logical path", async () => {
    const authority = authorityFixture();
    await writePack(authority, ["diagnostics/a.json"], "root_a");
    await writePack(authority, ["diagnostics/a.json", "diagnostics/b.json"], "root_b");
    await expect(iterateEventV3LogicalAuthority(authority)).rejects.toThrow(
      "event_v3_logical_authority_cross_pack_duplicate:diagnostics/a.json",
    );
  });
});

function authorityFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-v3-logical-test-"));
  roots.push(root);
  const authority = join(root, "authority");
  mkdirSync(join(authority, "diagnostics"), { recursive: true });
  writeFileSync(join(authority, "active.ndjson"), '{"event":"safe"}\n');
  writeFileSync(join(authority, "diagnostics", "a.json"), '{"code":"a"}\n');
  writeFileSync(join(authority, "diagnostics", "b.json"), '{"code":"b"}\n');
  return authority;
}

async function writePack(
  authority: string,
  paths: string[],
  rootId = "root_fixture",
): Promise<void> {
  await writeEventV3SupportPack({
    authority_root: authority,
    output_directory: join(authority, "support-packs"),
    root_id: rootId,
    genesis_id: "gen_fixture",
    verification_mode: "active-frozen-files",
    sources: paths.map((relative_path) => ({ relative_path, family: "diagnostic" as const })),
    minimum_harnery_version: "0.36.0",
    created_at: "2026-08-29T00:00:00.000Z",
  });
}
