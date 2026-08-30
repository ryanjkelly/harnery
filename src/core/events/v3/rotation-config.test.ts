import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_EVENT_LEDGER_ROTATE_ACTIVE_BYTES,
  resolveEventLedgerRotateActiveBytesV3,
} from "./rotation-config.ts";

const savedThreshold = process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES;
const savedXdgConfigHome = process.env.XDG_CONFIG_HOME;
const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeConfig(root: string, threshold: unknown): void {
  const configDirectory = join(root, ".harnery");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "config.jsonc"),
    `{// project override\n  "events": { "rotate_active_bytes": ${JSON.stringify(threshold)} }\n}\n`,
  );
}

afterEach(() => {
  if (savedThreshold === undefined) delete process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES;
  else process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = savedThreshold;
  if (savedXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdgConfigHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveEventLedgerRotateActiveBytesV3", () => {
  test("uses the default without an override", () => {
    delete process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES;
    process.env.XDG_CONFIG_HOME = temporaryRoot("harnery-v3-empty-user-config-");
    const root = temporaryRoot("harnery-v3-rotation-config-");

    expect(resolveEventLedgerRotateActiveBytesV3(root)).toBe(
      DEFAULT_EVENT_LEDGER_ROTATE_ACTIVE_BYTES,
    );
  });

  test("reads a JSONC project override, including the disabling value", () => {
    delete process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES;
    process.env.XDG_CONFIG_HOME = temporaryRoot("harnery-v3-empty-user-config-");
    const root = temporaryRoot("harnery-v3-rotation-config-");
    writeConfig(root, 0);

    expect(resolveEventLedgerRotateActiveBytesV3(root)).toBe(0);
  });

  test("keeps environment precedence over the project config", () => {
    const root = temporaryRoot("harnery-v3-rotation-config-");
    writeConfig(root, 2048);
    process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES = "4096";

    expect(resolveEventLedgerRotateActiveBytesV3(root)).toBe(4096);
  });

  test("uses the user value only when the project field is absent", () => {
    delete process.env.HARNERY_EVENT_V3_ROTATE_ACTIVE_BYTES;
    const root = temporaryRoot("harnery-v3-rotation-config-");
    const userRoot = temporaryRoot("harnery-v3-user-config-");
    process.env.XDG_CONFIG_HOME = userRoot;
    mkdirSync(join(userRoot, "harnery"), { recursive: true });
    writeFileSync(
      join(userRoot, "harnery", "config.jsonc"),
      '{ "events": { "rotate_active_bytes": 8192 } }\n',
    );

    expect(resolveEventLedgerRotateActiveBytesV3(root)).toBe(8192);
    writeConfig(root, "invalid");
    expect(resolveEventLedgerRotateActiveBytesV3(root)).toBe(
      DEFAULT_EVENT_LEDGER_ROTATE_ACTIVE_BYTES,
    );
  });
});
