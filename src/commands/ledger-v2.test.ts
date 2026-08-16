import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";
import {
  buildCandidateGenesisManifestV2,
  type CandidateProfileV2,
  EVENT_V2_SCHEMA_DIGEST,
  sha256V2,
  validateCandidateGenesisManifestV2,
} from "../core/events/v2/index.ts";
import { writeStagedControlPacket } from "./ledger-v2.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ledger-v2 command", () => {
  test("registers inspection and off-ledger preparation only", () => {
    const command = createHarneryProgram().commands.find(
      (candidate) => candidate.name() === "ledger-v2",
    );
    expect(command?.commands.map((candidate) => candidate.name())).toEqual([
      "status",
      "prepare-candidate",
      "prepare-activation",
      "verify",
    ]);
  });

  test("prepares a validated candidate without creating live control state", async () => {
    const root = tempRoot();
    const profilePath = join(root, "profile.json");
    const outputPath = join(root, "review", "candidate.json");
    writeFileSync(profilePath, JSON.stringify(profile()), "utf8");
    const emitted: unknown[] = [];
    const program = createHarneryProgram({
      context: { repoRoot: root, resolveCoordRoot: () => root },
      emit: captureEmit(emitted),
    });
    await program.parseAsync([
      "node",
      "harn",
      "ledger-v2",
      "prepare-candidate",
      "--profile",
      profilePath,
      "--out",
      outputPath,
      "--root-id",
      "root_fixture",
      "--instance-id",
      "inst_operator",
      "--producer-id",
      "prd_cutover",
      "--boot-id",
      "boot_cutover",
      "--sequence",
      "1",
      "--build-id",
      "build_fixture",
      "--platform",
      "linux",
    ]);

    expect(existsSync(outputPath)).toBeTrue();
    expect(existsSync(join(root, ".harnery", "ledgers", "v2", "genesis.json"))).toBeFalse();
    expect(
      validateCandidateGenesisManifestV2(JSON.parse(readFileSync(outputPath, "utf8"))).ok,
    ).toBe(true);
    expect(emitted).toMatchObject([{ installed: false }]);
  });

  test("refuses live paths and existing staged files", () => {
    const root = tempRoot();
    const packet = buildCandidateGenesisManifestV2({
      profile: profile(),
      root_id: "root_fixture",
      instance_id: "inst_operator",
      producer: {
        producer_id: "prd_cutover",
        boot_id: "boot_cutover",
        sequence: 1,
        build_id: "build_fixture",
        platform: "linux",
      },
    });
    const live = join(root, ".harnery", "ledgers", "v2", "genesis.json");
    expect(() => writeStagedControlPacket(root, live, packet)).toThrow(
      "live_control_path_forbidden",
    );
    const staged = join(root, "review", "candidate.json");
    writeStagedControlPacket(root, staged, packet);
    expect(() => writeStagedControlPacket(root, staged, packet)).toThrow(
      "staged_output_must_be_new",
    );
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "harnery-ledger-v2-command-"));
  roots.push(root);
  return root;
}

function profile(): CandidateProfileV2 {
  return {
    initial_schema_digest: EVENT_V2_SCHEMA_DIGEST,
    contract_source_digest: sha256V2("contract-source"),
    harnery_commit: "harnery-fixture",
    host_repository_commit: "host-fixture",
    producer_build_ids: ["build_fixture"],
    adapter_capability_profile_digests: [sha256V2("capability-fixture")],
    config_digest: sha256V2("config-fixture"),
    canonicalizer_version: "harnery-jcs-nfc-v1",
    fingerprint_version: "hmac-sha256-v1",
    privacy_key_epoch: "pep_fixture",
    v1_terminal_digest: sha256V2("v1-terminal"),
    v1_terminal_bytes: 1024,
    v1_terminal_rows: 4,
    candidate_created_at: "2026-08-16T18:00:00.000Z",
  };
}

function captureEmit(values: unknown[]): EmitContext {
  return {
    config() {},
    data(value) {
      values.push(value);
    },
    rows(value) {
      values.push(value);
    },
    text(value) {
      values.push(value);
    },
    file(path, summary) {
      values.push({ path, ...summary });
    },
    error(value) {
      values.push(value);
    },
    log() {},
    setExitCode() {},
  };
}
