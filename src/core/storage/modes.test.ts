import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJsonAtomic } from "./atomic-json.ts";
import { resetStorageSharing, stateDirMode, stateFileMode, stateModeTooOpen, stateSharing } from "./modes.ts";

let dir: string;
let cwd: string;
let umask: number;
const env = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harnery-modes-"));
  mkdirSync(join(dir, ".harnery"));
  cwd = process.cwd();
  umask = process.umask();
  process.chdir(dir);
  delete process.env.HARNERY_STORAGE_SHARING;
  resetStorageSharing();
});
afterEach(() => {
  process.chdir(cwd);
  process.umask(umask);
  process.env = { ...env };
  resetStorageSharing();
  rmSync(dir, { recursive: true, force: true });
});

const project = (sharing: string) =>
  writeFileSync(join(dir, ".harnery", "config.jsonc"), `{ // project\n "storage": { "sharing": "${sharing}" } }\n`);

test("state is owner-only unless the project asks for group sharing", () => {
  expect(stateSharing()).toBe("private");
  expect([stateDirMode(), stateFileMode()]).toEqual([0o700, 0o600]);
  expect(stateModeTooOpen(0o600)).toBe(false);
  expect(stateModeTooOpen(0o640)).toBe(true);
});

test("group sharing opens state to the group and never to other users", () => {
  project("group");
  expect(stateSharing()).toBe("group");
  expect([stateDirMode(), stateFileMode()]).toEqual([0o770, 0o660]);
  expect(stateModeTooOpen(0o660)).toBe(false);
  expect(stateModeTooOpen(0o664)).toBe(true);
  expect(stateModeTooOpen(0o606)).toBe(true);
});

test("the environment overrides the project file, and anything unrecognized reads as private", () => {
  project("group");
  process.env.HARNERY_STORAGE_SHARING = "private";
  expect(stateSharing()).toBe("private");
  resetStorageSharing();
  process.env.HARNERY_STORAGE_SHARING = "everyone";
  expect(stateSharing()).toBe("group");
  resetStorageSharing();
  delete process.env.HARNERY_STORAGE_SHARING;
  project("world");
  expect(stateSharing()).toBe("private");
});

test("a user-global setting cannot loosen a project", () => {
  const home = mkdtempSync(join(tmpdir(), "harnery-modes-home-"));
  try {
    mkdirSync(join(home, ".config", "harnery"), { recursive: true });
    writeFileSync(join(home, ".config", "harnery", "config.jsonc"), '{ "storage": { "sharing": "group" } }');
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = join(home, ".config");
    expect(stateSharing()).toBe("private");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("in group mode a state write is group-readable and writable even under a strict umask", () => {
  project("group");
  process.umask(0o077);
  expect(stateSharing()).toBe("group");
  expect(process.umask() & 0o070).toBe(0);
  const path = join(dir, ".harnery", "private", "x", "state.json");
  writePrivateJsonAtomic(path, { a: 1 });
  expect(statSync(path).mode & 0o777).toBe(0o660);
  expect(statSync(join(dir, ".harnery", "private", "x")).mode & 0o777).toBe(0o770);
});

test("in private mode the same write stays owner-only", () => {
  const path = join(dir, ".harnery", "private", "y", "state.json");
  writePrivateJsonAtomic(path, { a: 1 });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});
