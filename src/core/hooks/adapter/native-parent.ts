import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { discoverCodexSessionTranscript } from "./runtime-telemetry.ts";

export type NativeParentObservation =
  | { state: "observed"; parent_session_id: string; source_witness: string }
  | { state: "none"; reason: string; source_witness: string }
  | { state: "unknown"; reason: string };

export interface NativeParentRequest {
  adapter: string;
  native_session_id?: string;
  transcript_path?: string;
}

export interface NativeParentReaderOptions {
  discoverTranscript?: (sessionId: string, transcriptPath?: string) => string | undefined;
}

const HEADER_LIMIT = 1024 * 1024;
const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDINARY_SOURCES = new Set(["cli", "exec", "vscode", "app-server"]);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Native relationship evidence only; no prompt bodies, state writes or recipient authority. */
export function readNativeParentReference(
  request: NativeParentRequest,
  options: NativeParentReaderOptions = {},
): NativeParentObservation {
  if (request.adapter !== "codex") return unknown("native_parent_adapter_unsupported");
  const child = request.native_session_id;
  if (!child || !NATIVE_ID.test(child)) return unknown("native_child_identity_unavailable");
  let fd: number | undefined;
  try {
    const path = (options.discoverTranscript ?? discoverCodexSessionTranscript)(
      child,
      request.transcript_path,
    );
    if (!path) return unknown("native_parent_transcript_unavailable");
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink()) return unknown("native_parent_not_regular");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== entry.dev || before.ino !== entry.ino) {
      return unknown("native_parent_file_changed");
    }
    const header = readHeader(fd);
    if (!header) return unknown("native_parent_header_incomplete");
    // Appending later rows is normal. The same header must remain unchanged.
    const checked = readHeader(fd);
    const after = lstatSync(path);
    if (
      !checked?.equals(header) ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      return unknown("native_parent_file_changed");
    }
    const row = object(JSON.parse(header.toString("utf8")));
    const payload = object(row?.payload);
    if (row?.type !== "session_meta" || payload?.id !== child) {
      return unknown("native_parent_child_mismatch");
    }
    const source_witness = createHash("sha256").update(header).digest("hex");
    if (typeof payload.source === "string" && ORDINARY_SOURCES.has(payload.source)) {
      return { state: "none", reason: "native_ordinary_session", source_witness };
    }
    const source = object(payload.source);
    const spawn = object(object(source?.subagent)?.thread_spawn);
    const parent = spawn?.parent_thread_id;
    if (typeof parent !== "string" || !NATIVE_ID.test(parent)) {
      return unknown("native_parent_not_reported");
    }
    if (parent.toLowerCase() === child.toLowerCase())
      return unknown("native_parent_self_reference");
    return { state: "observed", parent_session_id: parent, source_witness };
  } catch {
    return unknown("native_parent_metadata_unreadable");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readHeader(fd: number): Buffer | undefined {
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < HEADER_LIMIT) {
    const buffer = Buffer.alloc(Math.min(16 * 1024, HEADER_LIMIT - offset));
    const bytes = readSync(fd, buffer, 0, buffer.length, offset);
    if (bytes === 0) return undefined;
    const data = buffer.subarray(0, bytes);
    const newline = data.indexOf(10);
    if (newline >= 0) return Buffer.concat([...chunks, data.subarray(0, newline)]);
    chunks.push(data);
    offset += bytes;
  }
  return undefined;
}

function unknown(reason: string): NativeParentObservation {
  return { state: "unknown", reason };
}
