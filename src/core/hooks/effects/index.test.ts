import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "../../../../tests/helpers/remove-dir.ts";
import { resetBashCache, resolveBash } from "../../../lib/tools/bash.ts";
import { playSound, runSessionSyncExtension } from "./index.ts";

const MARKER_SCRIPT = 'printf "%s" "$1" > "$HARNERY_TEST_MARKER"\n';

let root: string;
let marker: string;
const saved = {
  override: process.env.HARNERY_BASH_PATH,
  marker: process.env.HARNERY_TEST_MARKER,
};

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function writeScript(...segments: string[]): void {
  const dir = join(root, ...segments.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, segments[segments.length - 1] ?? ""), MARKER_SCRIPT);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harnery-effects-"));
  // Forward slashes: bash on every platform accepts them in a redirect target.
  marker = join(root, "marker.txt").replace(/\\/g, "/");
  process.env.HARNERY_TEST_MARKER = marker;
  writeScript("scripts", "hooks", "play-sound.sh");
  writeScript("scripts", "hooks", "harness", "claude-code", "extensions", "session-sync.sh");
  resetBashCache();
});

afterEach(() => {
  restore("HARNERY_BASH_PATH", saved.override);
  restore("HARNERY_TEST_MARKER", saved.marker);
  resetBashCache();
  removeDir(root);
});

describe("hook effects without a usable bash", () => {
  beforeEach(() => {
    process.env.HARNERY_BASH_PATH = join(root, "no-such-dir", "bash");
    resetBashCache();
  });

  test("resolveBash reports null", () => {
    expect(resolveBash()).toBeNull();
  });

  test("playSound is a silent no-op", () => {
    expect(() => playSound(root, "stop", "s1")).not.toThrow();
    expect(existsSync(marker)).toBe(false);
  });

  test("runSessionSyncExtension is a silent no-op", async () => {
    expect(() => runSessionSyncExtension(root, true)).not.toThrow();
    await Bun.sleep(200);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("hook effects with the resolved bash", () => {
  beforeEach(() => {
    delete process.env.HARNERY_BASH_PATH;
    resetBashCache();
  });

  test.skipIf(resolveBashUncached() === null)("playSound runs the script under bash", () => {
    playSound(root, "stop", "s1");
    expect(readFileSync(marker, "utf8")).toBe("stop");
  });
});

function resolveBashUncached(): string | null {
  const prior = process.env.HARNERY_BASH_PATH;
  delete process.env.HARNERY_BASH_PATH;
  resetBashCache();
  const found = resolveBash();
  restore("HARNERY_BASH_PATH", prior);
  resetBashCache();
  return found;
}
