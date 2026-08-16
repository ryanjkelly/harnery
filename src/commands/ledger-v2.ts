import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { Command } from "commander";
import type { EmitContext, HarneryProgramContext } from "../commander.ts";
import {
  type ActivationManifestV2,
  buildActivationManifestV2,
  buildCandidateGenesisManifestV2,
  type CandidateGenesisManifestV2,
  type CandidateProfileV2,
  type ControlProducerV2,
  candidateManifestDigestV2,
  canonicalJsonV2,
  readEventV2ControlState,
  validateActivationManifestV2,
  validateCandidateGenesisManifestV2,
} from "../core/events/v2/index.ts";
import { fsyncParentDirectory } from "../core/workflow/durable-record.ts";

interface ProducerOptions {
  producerId: string;
  bootId: string;
  sequence: string;
  buildId: string;
  platform: string;
}

/** Operator-only staging and inspection. This command never installs a live control record. */
export function registerLedgerV2Command(
  program: Command,
  emit: EmitContext,
  context?: HarneryProgramContext,
): void {
  const command = program
    .command("ledger-v2")
    .description("Inspect or stage event-ledger V2 control packets without activating them");

  command
    .command("status")
    .description("Read the V2 candidate/activation gate without repairing it")
    .action(() => {
      try {
        emit.data(readEventV2ControlState(coordRoot(context)));
      } catch (error) {
        emitFailure(emit, "ledger_v2_status_failed", error);
      }
    });

  addProducerOptions(
    command
      .command("prepare-candidate")
      .description("Write a validated candidate packet to an off-ledger staging path")
      .requiredOption("--profile <path>", "Candidate profile JSON")
      .requiredOption("--out <path>", "New off-ledger output file")
      .requiredOption("--root-id <id>", "Canonical root_ identity")
      .requiredOption("--instance-id <id>", "Operator inst_ identity"),
  ).action(
    (
      options: ProducerOptions & {
        profile: string;
        out: string;
        rootId: string;
        instanceId: string;
      },
    ) => {
      try {
        const root = coordRoot(context);
        const profile = readJson(options.profile) as CandidateProfileV2;
        const manifest = buildCandidateGenesisManifestV2({
          profile,
          root_id: prefixed(options.rootId, "root_"),
          instance_id: prefixed(options.instanceId, "inst_"),
          producer: producer(options),
        });
        const path = writeStagedControlPacket(root, options.out, manifest);
        emit.file(path, {
          kind: manifest.kind,
          candidate_manifest_digest: candidateManifestDigestV2(manifest),
          event_id: manifest.event.event_id,
          installed: false,
        });
      } catch (error) {
        emitFailure(emit, "ledger_v2_candidate_prepare_failed", error);
      }
    },
  );

  addProducerOptions(
    command
      .command("prepare-activation")
      .description("Write an approval-bound activation packet to an off-ledger staging path")
      .requiredOption("--candidate <path>", "Validated candidate manifest")
      .requiredOption("--approval-record-id <id>", "Durable approval record identifier")
      .requiredOption("--approved-at <timestamp>", "Approval timestamp with milliseconds and Z")
      .requiredOption("--out <path>", "New off-ledger output file"),
  ).action(
    (
      options: ProducerOptions & {
        candidate: string;
        approvalRecordId: string;
        approvedAt: string;
        out: string;
      },
    ) => {
      try {
        const root = coordRoot(context);
        const candidate = validatedCandidate(readJson(options.candidate));
        const manifest = buildActivationManifestV2({
          candidate,
          approval_record_id: options.approvalRecordId,
          activation_approved_at: options.approvedAt,
          producer: producer(options),
        });
        const path = writeStagedControlPacket(root, options.out, manifest);
        emit.file(path, {
          kind: manifest.kind,
          candidate_manifest_digest: manifest.candidate_manifest_digest,
          event_id: manifest.event.event_id,
          installed: false,
        });
      } catch (error) {
        emitFailure(emit, "ledger_v2_activation_prepare_failed", error);
      }
    },
  );

  command
    .command("verify")
    .description("Validate staged candidate and optional activation packets")
    .requiredOption("--candidate <path>", "Candidate manifest")
    .option("--activation <path>", "Activation manifest")
    .action((options: { candidate: string; activation?: string }) => {
      try {
        const candidate = validatedCandidate(readJson(options.candidate));
        let activation: ActivationManifestV2 | undefined;
        if (options.activation) {
          const result = validateActivationManifestV2(readJson(options.activation), candidate);
          if (!result.ok) throw new Error(`activation_invalid:${result.reason}`);
          activation = result.value;
        }
        emit.data({
          ok: true,
          candidate_manifest_digest: candidateManifestDigestV2(candidate),
          candidate_event_id: candidate.event.event_id,
          activation_event_id: activation?.event.event_id,
          installed: false,
        });
      } catch (error) {
        emitFailure(emit, "ledger_v2_verify_failed", error);
      }
    });
}

function addProducerOptions(command: Command): Command {
  return command
    .requiredOption("--producer-id <id>", "Control producer prd_ identity")
    .requiredOption("--boot-id <id>", "Control producer boot_ identity")
    .requiredOption("--sequence <n>", "Positive producer sequence")
    .requiredOption("--build-id <id>", "Control producer build_ identity")
    .requiredOption("--platform <name>", "linux, windows, macos, or unknown");
}

function producer(options: ProducerOptions): ControlProducerV2 {
  const sequence = Number(options.sequence);
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("sequence_must_be_positive");
  if (!isPlatform(options.platform)) throw new Error("platform_invalid");
  return {
    producer_id: prefixed(options.producerId, "prd_"),
    boot_id: prefixed(options.bootId, "boot_"),
    sequence,
    build_id: prefixed(options.buildId, "build_"),
    platform: options.platform,
  };
}

function prefixed<P extends string>(value: string, prefix: P): `${P}${string}` {
  if (!value.startsWith(prefix)) throw new Error(`identifier_requires_${prefix}`);
  return value as `${P}${string}`;
}

function isPlatform(value: string): value is ControlProducerV2["platform"] {
  return value === "linux" || value === "windows" || value === "macos" || value === "unknown";
}

function coordRoot(context: HarneryProgramContext | undefined): string {
  const root = context?.resolveCoordRoot?.() ?? context?.repoRoot;
  if (!root) throw new Error("coordination_root_unavailable");
  return resolve(root);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

function validatedCandidate(value: unknown): CandidateGenesisManifestV2 {
  const result = validateCandidateGenesisManifestV2(value);
  if (!result.ok) throw new Error(`candidate_genesis_invalid:${result.reason}`);
  return result.value;
}

export function writeStagedControlPacket(
  coordRootPath: string,
  outputPath: string,
  packet: CandidateGenesisManifestV2 | ActivationManifestV2,
): string {
  const output = resolve(outputPath);
  const liveRoot = resolve(coordRootPath, ".harnery", "ledgers", "v2");
  if (inside(liveRoot, output)) throw new Error("live_control_path_forbidden");
  if (existsSync(output)) throw new Error("staged_output_must_be_new");
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  const fd = openSync(output, "wx", 0o600);
  try {
    writeFileSync(fd, `${canonicalJsonV2(packet)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncParentDirectory(output);
  return output;
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function emitFailure(emit: EmitContext, code: string, error: unknown): void {
  emit.error({ code, message: error instanceof Error ? error.message : String(error) });
  emit.setExitCode(1);
}
