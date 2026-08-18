import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { Adapter } from "../../../adapter.ts";
import type { ParsedPayload } from "../../../hooks/adapter/parse.ts";
import { fsyncParentDirectory } from "../../../workflow/durable-record.ts";
import type { EventV2WriteMode } from "../control.ts";
import { EVENT_V2_LEDGER_RELATIVE_ROOT } from "../writer.ts";
import type { HookSignalV2 } from "./hook.ts";

/**
 * Durable intake spool for hook signals, plus the producer diagnostics spool.
 *
 * A hook process appends its parsed signal here BEFORE reading or validating
 * any producer state, so a lost lease, a crash, or a state-format mismatch can
 * never destroy a delivered signal. Whichever process holds that session's
 * producer-state lease drains the spool in append order and deletes each
 * record only after its outcome is durably published. Intake records hold raw
 * payloads transiently under owner-only permissions; anything that cannot
 * become a ledger event is preserved in the diagnostics spool with raw content
 * fields reduced to byte counts and digests.
 */

const INTAKE_FORMAT = "harnery-v2-hook-intake" as const;
const INTAKE_VERSION = 1 as const;
const HOOK_SIGNALS: ReadonlySet<string> = new Set([
  "session-start",
  "session-end",
  "user-prompt-submit",
  "stop",
  "stop-failure",
  "pre-tool-use",
  "post-tool-use",
  "post-tool-use-failure",
  "permission-request",
  "sub-agent-start",
  "sub-agent-stop",
  "pre-compact",
  "post-compact",
]);
const DIAGNOSTIC_METADATA_KEYS = new Set([
  "adapter",
  "signal",
  "mode",
  "state",
  "reason",
  "code",
  "instance_id",
  "producer_id",
  "build_id",
  "platform",
  "bridge",
  "session_hash",
  "event_id",
  "span_id",
  "generation_id",
  "turn_id",
  "tool_name",
  "outcome",
  "sequence",
  "expected",
  "actual",
]);

export interface HookIntakeRecordV2 {
  format: typeof INTAKE_FORMAT;
  format_version: typeof INTAKE_VERSION;
  mode: EventV2WriteMode;
  signal: HookSignalV2;
  payload: ParsedPayload;
  adapter: Adapter;
  instance_id: `inst_${string}`;
  producer_id: `prd_${string}`;
  build_id: `build_${string}`;
  platform: "linux" | "windows" | "macos" | "unknown";
  bridge?: "codex-wsl";
  adapterVersion?: string;
  harnessVersion?: string;
  monotonic_ns?: string;
  hook_name?: string;
  hook_duration_ms?: number;
}

export interface HookIntakeGroupV2 {
  adapter: Adapter;
  session_hash: `hid_${string}`;
  directory: string;
}

export interface HookIntakeEntryV2 {
  path: string;
  name: string;
  /** Undefined when the file is unreadable or fails shape validation. */
  record: HookIntakeRecordV2 | undefined;
}

function intakeRoot(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V2_LEDGER_RELATIVE_ROOT, "intake", "hook");
}

function diagnosticsRoot(coordRoot: string): string {
  return join(resolve(coordRoot), EVENT_V2_LEDGER_RELATIVE_ROOT, "diagnostics");
}

export function hookIntakeGroupDirV2(
  coordRoot: string,
  adapter: Adapter,
  sessionHash: `hid_${string}`,
): string {
  return join(intakeRoot(coordRoot), adapter, sessionHash);
}

/** Lexicographically ordered filename that preserves per-process append order. */
function intakeOrderKey(): string {
  return [
    String(Date.now()).padStart(15, "0"),
    process.hrtime.bigint().toString().padStart(20, "0"),
    String(process.pid),
    randomUUID(),
  ].join("-");
}

function ensureOwnerOnlyDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeOwnerOnlyFileDurably(path: string, contents: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncParentDirectory(path);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function appendHookIntakeRecordV2(
  coordRoot: string,
  sessionHash: `hid_${string}`,
  record: HookIntakeRecordV2,
): string {
  const directory = hookIntakeGroupDirV2(coordRoot, record.adapter, sessionHash);
  ensureOwnerOnlyDirectory(join(intakeRoot(coordRoot), record.adapter));
  ensureOwnerOnlyDirectory(directory);
  const path = join(directory, `${intakeOrderKey()}.json`);
  writeOwnerOnlyFileDurably(path, `${JSON.stringify(record)}\n`);
  return path;
}

export function listHookIntakeGroupsV2(coordRoot: string): HookIntakeGroupV2[] {
  const root = intakeRoot(coordRoot);
  if (!existsSync(root)) return [];
  const groups: HookIntakeGroupV2[] = [];
  for (const adapter of ["claude-code", "codex", "cursor"] as const) {
    const adapterDir = join(root, adapter);
    if (!existsSync(adapterDir)) continue;
    const metadata = lstatSync(adapterDir);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("V2 intake directory is unsafe");
    }
    for (const name of readdirSync(adapterDir).filter((entry) =>
      /^hid_[a-f0-9]{64}$/.test(entry),
    )) {
      groups.push({
        adapter,
        session_hash: name as `hid_${string}`,
        directory: join(adapterDir, name),
      });
    }
  }
  return groups;
}

export function listHookIntakeRecordsV2(directory: string): HookIntakeEntryV2[] {
  if (!existsSync(directory)) return [];
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("V2 intake directory is unsafe");
  }
  const entries: HookIntakeEntryV2[] = [];
  for (const name of readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()) {
    const path = join(directory, name);
    entries.push({ path, name, record: readIntakeRecord(path) });
  }
  return entries;
}

export function removeIntakeRecordV2(path: string): void {
  if (existsSync(path)) unlinkSync(path);
  fsyncParentDirectory(path);
}

function readIntakeRecord(path: string): HookIntakeRecordV2 | undefined {
  let parsed: unknown;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return undefined;
    if ((metadata.mode & 0o077) !== 0) return undefined;
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as HookIntakeRecordV2;
  if (
    record.format !== INTAKE_FORMAT ||
    record.format_version !== INTAKE_VERSION ||
    !["candidate", "active"].includes(record.mode) ||
    !HOOK_SIGNALS.has(record.signal) ||
    !record.payload ||
    typeof record.payload !== "object" ||
    !["claude-code", "codex", "cursor"].includes(record.adapter) ||
    !/^inst_[a-zA-Z0-9._-]{1,128}$/.test(record.instance_id) ||
    !/^prd_[a-zA-Z0-9._-]{1,64}$/.test(record.producer_id) ||
    !/^build_[a-zA-Z0-9._-]{1,127}$/.test(record.build_id) ||
    !["linux", "windows", "macos", "unknown"].includes(record.platform) ||
    (record.bridge !== undefined && record.bridge !== "codex-wsl") ||
    (record.monotonic_ns !== undefined && !/^\d+$/.test(record.monotonic_ns)) ||
    (record.hook_name !== undefined &&
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,127}$/.test(record.hook_name)) ||
    (record.hook_duration_ms !== undefined &&
      (!Number.isSafeInteger(record.hook_duration_ms) || record.hook_duration_ms < 0))
  ) {
    return undefined;
  }
  return record;
}

/**
 * Preserve a signal that could not become a ledger event. Raw content fields
 * are reduced to byte counts and digests so the diagnostics spool never holds
 * prompt, tool input, or tool output bodies (invariant: delivered evidence is
 * never silently destroyed, and never re-exposed either).
 */
export function writeProducerDiagnosticV2(
  coordRoot: string,
  category: string,
  record: Record<string, unknown>,
): string | undefined {
  try {
    const safeCategory = category.replace(/[^a-z0-9_-]/gi, "_").slice(0, 64);
    const root = diagnosticsRoot(coordRoot);
    ensureOwnerOnlyDirectory(root);
    const path = join(root, `${safeCategory}-${intakeOrderKey()}.json`);
    const contents = `${JSON.stringify({
      recorded_at: new Date().toISOString(),
      category: safeCategory,
      ...redactDiagnosticRecord(record),
    })}\n`;
    writeOwnerOnlyFileDurably(path, contents);
    return path;
  } catch {
    // Diagnostics are best-effort; they must never break the producer path.
    return undefined;
  }
}

function redactDiagnosticRecord(record: Record<string, unknown>): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!DIAGNOSTIC_METADATA_KEYS.has(key)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
    ) {
      metadata[key] = value;
    }
  }
  return { ...metadata, content_fingerprint: contentDigest(record) };
}

function contentDigest(value: unknown): { bytes: number; sha256: string } {
  const serialized = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  return {
    bytes: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}
