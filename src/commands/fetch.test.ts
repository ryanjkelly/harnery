import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarneryProgram, type EmitContext } from "../commander.ts";

const realFetch = globalThis.fetch;
const roots: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function captureEmit(): {
  emit: EmitContext;
  data: unknown[];
  files: Array<{ path: string; summary: Record<string, unknown> }>;
  text: string[];
} {
  const data: unknown[] = [];
  const files: Array<{ path: string; summary: Record<string, unknown> }> = [];
  const text: string[] = [];
  return {
    data,
    files,
    text,
    emit: {
      config: () => {},
      data: (payload) => data.push(payload),
      rows: () => {},
      text: (value) => text.push(value),
      file: (path, summary) => files.push({ path, summary }),
      error: (error) => {
        throw error;
      },
      log: () => {},
      setExitCode: () => {},
    },
  };
}

describe("fetch command response bodies", () => {
  test("writes --output byte for byte and reports the real byte count", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-fetch-command-"));
    roots.push(root);
    const output = join(root, "download.bin");
    const payload = Uint8Array.from([0x00, 0x7f, 0x80, 0xfe, 0xff]);
    globalThis.fetch = (async () =>
      new Response(payload, {
        headers: { "content-type": "text/plain" },
        statusText: "OK",
      })) as unknown as typeof fetch;
    const captured = captureEmit();

    await createHarneryProgram({ emit: captured.emit }).parseAsync(
      ["fetch", "https://example.com/file", "--no-cookies", "--output", output],
      { from: "user" },
    );

    expect(new Uint8Array(readFileSync(output))).toEqual(payload);
    expect(captured.files).toEqual([
      {
        path: output,
        summary: { bytes: payload.byteLength, status: 200, status_text: "OK" },
      },
    ]);
  });

  test("creates an empty --output file for an empty response", async () => {
    const root = mkdtempSync(join(tmpdir(), "harnery-fetch-command-"));
    roots.push(root);
    const output = join(root, "empty.bin");
    globalThis.fetch = (async () => new Response(null)) as unknown as typeof fetch;
    const captured = captureEmit();

    await createHarneryProgram({ emit: captured.emit }).parseAsync(
      ["fetch", "https://example.com/empty", "--no-cookies", "--output", output],
      { from: "user" },
    );

    expect(readFileSync(output).byteLength).toBe(0);
    expect(captured.files[0]?.summary).toMatchObject({ bytes: 0, status: 200 });
  });

  test("keeps stdout and --json bodies as UTF-8 text", async () => {
    const payload = new TextEncoder().encode("café");
    globalThis.fetch = (async () => new Response(payload)) as unknown as typeof fetch;

    const stdout = captureEmit();
    await createHarneryProgram({ emit: stdout.emit }).parseAsync(
      ["fetch", "https://example.com/text", "--no-cookies"],
      { from: "user" },
    );
    expect(stdout.text).toEqual(["café"]);

    const json = captureEmit();
    await createHarneryProgram({ emit: json.emit }).parseAsync(
      ["fetch", "https://example.com/text", "--no-cookies", "--json"],
      { from: "user" },
    );
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({ body: "café", status: 200 });
  });
});
