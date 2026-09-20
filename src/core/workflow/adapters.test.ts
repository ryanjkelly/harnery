import { describe, expect, test } from "bun:test";
import {
  ADAPTER_BINARIES,
  ADAPTER_INSTALL_HINTS,
  ADAPTER_LOGIN_HINTS,
  detectInstalledAdapters,
  notFoundError,
} from "./adapters.ts";
import type { AdapterName } from "./types.ts";

describe("adapter metadata", () => {
  const ALL: AdapterName[] = ["claude-code", "codex", "cursor", "opencode"];

  test("every adapter has a binary, install hint, and login hint", () => {
    for (const h of ALL) {
      expect(ADAPTER_BINARIES[h]).toBeTruthy();
      expect(ADAPTER_INSTALL_HINTS[h]).toBeTruthy();
      expect(ADAPTER_LOGIN_HINTS[h]).toBeTruthy();
    }
  });

  test("notFoundError names the binary and carries both hints", () => {
    for (const h of ALL) {
      const msg = notFoundError(h);
      expect(msg).toContain(ADAPTER_BINARIES[h]);
      expect(msg).toContain(ADAPTER_INSTALL_HINTS[h]);
      expect(msg).toContain(ADAPTER_LOGIN_HINTS[h]);
    }
  });
});

describe("detectInstalledAdapters", () => {
  test("keeps only adapters the probe answers for, in profile order", () => {
    const seen: string[] = [];
    const installed = detectInstalledAdapters((binary) => {
      seen.push(binary);
      return binary === "cursor-agent" || binary === "opencode" ? "probe-ok" : null;
    });
    expect(installed).toEqual(["cursor", "opencode"]);
    expect(seen).toEqual(["claude", "codex", "cursor-agent", "opencode"]);
  });

  test("no probe answers → no adapters", () => {
    expect(detectInstalledAdapters(() => null)).toEqual([]);
  });
});
