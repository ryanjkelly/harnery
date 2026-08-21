import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableHeadlessBackends,
  runHeadless,
  runHeadlessOn,
  whichBin,
} from "../../src/lib/headless/index.ts";

/**
 * The suite fakes each harness CLI with a shell script on a temp PATH, so it
 * exercises real process spawning, argv shapes, stdout/file output parsing,
 * and the fallback walk — without any harness installed. POSIX-only (the
 * scripts are #!/bin/sh); CI and the dev machines are Linux/macOS.
 */

let binDir: string;
let savedPath: string | undefined;
let savedForced: string | undefined;

function fakeBin(name: string, script: string): string {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** A fake `claude` that emits the headless JSON envelope. */
function fakeClaude(result: string, opts: { error?: boolean } = {}) {
  const envelope = JSON.stringify({ is_error: opts.error ?? false, result });
  // argv capture lets tests assert flag shapes without parsing in sh.
  fakeBin(
    "claude",
    `printf '%s\\n' "$@" > "${join(binDir, "claude.argv")}"\nprintf '%s' '${envelope}'`,
  );
}

/** A fake `codex` that writes its reply to the --output-last-message path. */
function fakeCodex(reply: string) {
  fakeBin(
    "codex",
    [
      `printf '%s\\n' "$@" > "${join(binDir, "codex.argv")}"`,
      // walk argv for --output-last-message and write the reply there
      `out=""; prev=""`,
      `for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done`,
      `[ -n "$out" ] && printf '%s' '${reply}' > "$out"`,
    ].join("\n"),
  );
}

function fakeCursor(reply: string) {
  fakeBin("cursor-agent", `printf '%s' '${reply}'`);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), "headless-test-"));
  savedPath = process.env.PATH;
  savedForced = process.env.HARNERY_HEADLESS_BACKEND;
  process.env.PATH = binDir; // ONLY the fakes are visible
  delete process.env.HARNERY_HEADLESS_BACKEND;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedForced === undefined) delete process.env.HARNERY_HEADLESS_BACKEND;
  else process.env.HARNERY_HEADLESS_BACKEND = savedForced;
  rmSync(binDir, { recursive: true, force: true });
});

describe("whichBin / availability", () => {
  test("finds only executables on PATH, in preference order", () => {
    expect(availableHeadlessBackends()).toEqual([]);
    fakeCursor("x");
    fakeClaude("x");
    expect(availableHeadlessBackends()).toEqual(["claude-code", "cursor"]);
    expect(whichBin("claude")).toBe(join(binDir, "claude"));
    expect(whichBin("nonexistent-harness")).toBeUndefined();
  });
});

describe("runHeadlessOn", () => {
  test("claude-code: parses the JSON envelope and passes model/turn flags", async () => {
    fakeClaude("the reply");
    const res = await runHeadlessOn("claude-code", { prompt: "hi", model: "m-test", maxTurns: 2 });
    expect(res).toEqual({ text: "the reply", backend: "claude-code" });
    const argv = readFileSync(join(binDir, "claude.argv"), "utf-8").split("\n");
    expect(argv).toContain("--model");
    expect(argv).toContain("m-test");
    expect(argv).toContain("--max-turns");
    expect(argv).toContain("2");
    // no images staged → no Read tool grant
    expect(argv).not.toContain("--allowedTools");
  });

  test("claude-code: an is_error envelope throws", async () => {
    fakeClaude("boom", { error: true });
    expect(runHeadlessOn("claude-code", { prompt: "hi" })).rejects.toThrow("boom");
  });

  test("codex: reads the reply from --output-last-message and attaches images", async () => {
    fakeCodex("codex says");
    const res = await runHeadlessOn("codex", {
      prompt: ({ imagePaths }) => `look at ${imagePaths[0]}`,
      images: [{ data: Buffer.from("png-bytes") }],
    });
    expect(res).toEqual({ text: "codex says", backend: "codex" });
    const argv = readFileSync(join(binDir, "codex.argv"), "utf-8").split("\n");
    expect(argv).toContain("-i");
    expect(argv.some((a) => a.endsWith("image-1.png"))).toBe(true);
    expect(argv.some((a) => a.startsWith("look at ") && a.endsWith("image-1.png"))).toBe(true);
  });

  test("cursor: returns stdout text", async () => {
    fakeCursor("cursor says");
    const res = await runHeadlessOn("cursor", { prompt: "hi" });
    expect(res).toEqual({ text: "cursor says", backend: "cursor" });
  });

  test("an empty reply fails closed", async () => {
    fakeCursor("");
    expect(runHeadlessOn("cursor", { prompt: "hi" })).rejects.toThrow("empty reply");
  });

  test("a missing backend throws instead of skipping", async () => {
    expect(runHeadlessOn("codex", { prompt: "hi" })).rejects.toThrow("not installed");
  });
});

describe("runHeadless (chain)", () => {
  test("falls back past an installed-but-failing backend", async () => {
    fakeBin("claude", "exit 1"); // installed, broken
    fakeCodex("recovered");
    const res = await runHeadless({ prompt: "hi" });
    expect(res).toEqual({ text: "recovered", backend: "codex" });
  });

  test("reports every failure when the whole chain fails", async () => {
    fakeBin("claude", "exit 1");
    fakeBin("codex", "exit 1");
    expect(runHeadless({ prompt: "hi" })).rejects.toThrow(/claude-code:.*\n.*codex:/s);
  });

  test("fallback:false stops after the first backend", async () => {
    fakeBin("claude", "exit 1");
    fakeCodex("never reached");
    expect(runHeadless({ prompt: "hi" }, { fallback: false })).rejects.toThrow(
      "every headless backend failed",
    );
  });

  test("opts.backends restricts and reorders the walk", async () => {
    fakeClaude("claude says");
    fakeCursor("cursor says");
    const res = await runHeadless({ prompt: "hi" }, { backends: ["cursor"] });
    expect(res.backend).toBe("cursor");
  });

  test("HARNERY_HEADLESS_BACKEND forces one backend with no fallback", async () => {
    fakeBin("claude", "exit 1");
    fakeCursor("cursor says");
    process.env.HARNERY_HEADLESS_BACKEND = "claude-code";
    expect(runHeadless({ prompt: "hi" })).rejects.toThrow();
    process.env.HARNERY_HEADLESS_BACKEND = "cursor";
    const res = await runHeadless({ prompt: "hi" });
    expect(res.backend).toBe("cursor");
  });

  test("nothing installed names the backends it looked for", async () => {
    expect(runHeadless({ prompt: "hi" })).rejects.toThrow("no headless backend installed");
  });
});
