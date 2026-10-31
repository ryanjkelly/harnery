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

describe("fetch command header policy", () => {
  test("a refused caller header stops the run before any request", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("sent");
    }) as unknown as typeof fetch;
    const seen: Array<[string, string, string]> = [];
    const captured = captureEmit();
    await expect(
      createHarneryProgram({
        emit: captured.emit,
        context: {
          headerPolicy: (host, name, value) => {
            seen.push([host, name, value]);
            return name === "X-Secret"
              ? { allow: false, message: `refused ${name} to ${host}` }
              : { allow: true };
          },
        },
      }).parseAsync(
        [
          "fetch",
          "https://unlisted.example/path",
          "--no-cookies",
          "--no-pace",
          "-H",
          "Accept: text/html",
          "X-Secret: synthetic-value",
        ],
        { from: "user" },
      ),
    ).rejects.toMatchObject({
      code: "fetch_error",
      message: "refused X-Secret to unlisted.example",
    });
    expect(called).toBe(false);
    expect(seen).toEqual([
      ["unlisted.example", "Accept", "text/html"],
      ["unlisted.example", "X-Secret", "synthetic-value"],
    ]);
  });

  test("allowed headers are sent and the default User-Agent is never checked", async () => {
    let sent: Headers | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      sent = new Headers(init?.headers);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const names: string[] = [];
    const captured = captureEmit();
    await createHarneryProgram({
      emit: captured.emit,
      context: {
        headerPolicy: (_host, name) => {
          names.push(name);
          return { allow: true };
        },
      },
    }).parseAsync(
      ["fetch", "https://vendor.example/", "--no-cookies", "--no-pace", "-H", "X-Custom: 1"],
      { from: "user" },
    );
    expect(names).toEqual(["X-Custom"]);
    expect(sent?.get("x-custom")).toBe("1");
    expect(captured.text).toEqual(["ok"]);
  });
});
