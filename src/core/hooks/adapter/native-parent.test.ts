import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNativeParentReference } from "./native-parent.ts";

const CHILD = "00000000-0000-4000-8000-000000000001";
const PARENT = "00000000-0000-4000-8000-000000000002";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function transcript(source: unknown, id = CHILD) {
  const root = mkdtempSync(join(tmpdir(), "native-parent-"));
  roots.push(root);
  const path = join(root, "rollout.jsonl");
  const header = JSON.stringify({ type: "session_meta", payload: { id, source } });
  writeFileSync(path, `${header}\nPRIVATE_PROMPT_AND_TOOL_SENTINEL\n`);
  return { path, header };
}

function read(path: string) {
  return readNativeParentReference(
    { adapter: "codex", native_session_id: CHILD },
    { discoverTranscript: () => path },
  );
}

test("reads the exact native child header and retains only parent identity plus witness", () => {
  const { path, header } = transcript({ subagent: { thread_spawn: { parent_thread_id: PARENT } } });
  const before = readFileSync(path);
  expect(read(path)).toEqual({
    state: "observed",
    parent_session_id: PARENT,
    source_witness: createHash("sha256").update(header).digest("hex"),
  });
  expect(JSON.stringify(read(path))).not.toContain("PRIVATE_PROMPT_AND_TOOL_SENTINEL");
  expect(readFileSync(path)).toEqual(before);
});

test("a positive ordinary native source is distinct from missing lineage", () => {
  expect(read(transcript("cli").path)).toMatchObject({
    state: "none",
    reason: "native_ordinary_session",
  });
  expect(read(transcript({ subagent: {} }).path)).toEqual({
    state: "unknown",
    reason: "native_parent_not_reported",
  });
});

test("refuses a different native child and never uses a parent-looking label", () => {
  expect(
    read(transcript({ subagent: { thread_spawn: { parent_thread_id: PARENT } } }, PARENT).path),
  ).toEqual({ state: "unknown", reason: "native_parent_child_mismatch" });
  expect(read(transcript({ agent_nickname: "parent", parent_thread_id: PARENT }).path)).toEqual({
    state: "unknown",
    reason: "native_parent_not_reported",
  });
});

test("refuses self-parent and malformed parent identity", () => {
  for (const parent of [CHILD, "not-a-native-id"]) {
    expect(
      read(transcript({ subagent: { thread_spawn: { parent_thread_id: parent } } }).path).state,
    ).toBe("unknown");
  }
});

test("does not follow a symlink to a valid-looking header", () => {
  const { path } = transcript({ subagent: { thread_spawn: { parent_thread_id: PARENT } } });
  const link = `${path}.link`;
  symlinkSync(path, link);
  expect(read(link)).toEqual({ state: "unknown", reason: "native_parent_not_regular" });
});

test("requires a complete bounded first row and does not search later rows", () => {
  const { path, header } = transcript({ subagent: { thread_spawn: { parent_thread_id: PARENT } } });
  for (const bytes of [header, `${" ".repeat(1024 * 1024)}\n${header}\n`, `{}\n${header}\n`]) {
    writeFileSync(path, bytes);
    expect(read(path).state).toBe("unknown");
  }
});

test("malformed JSON and absent/ambiguous discovery remain unknown", () => {
  const { path } = transcript("cli");
  writeFileSync(path, "{not-json}\n");
  expect(read(path)).toEqual({ state: "unknown", reason: "native_parent_metadata_unreadable" });
  expect(
    readNativeParentReference(
      { adapter: "codex", native_session_id: CHILD },
      { discoverTranscript: () => undefined },
    ),
  ).toEqual({ state: "unknown", reason: "native_parent_transcript_unavailable" });
});

test("unsupported adapters and fingerprinted session IDs never open a transcript", () => {
  let discoveries = 0;
  const options = {
    discoverTranscript: () => {
      discoveries++;
      return undefined;
    },
  };
  expect(
    readNativeParentReference({ adapter: "cursor", native_session_id: CHILD }, options).state,
  ).toBe("unknown");
  expect(
    readNativeParentReference({ adapter: "codex", native_session_id: "sid_fingerprint" }, options)
      .state,
  ).toBe("unknown");
  expect(discoveries).toBe(0);
});
