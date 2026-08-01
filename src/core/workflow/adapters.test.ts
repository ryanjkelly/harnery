import { describe, expect, test } from "bun:test";
import {
  ADAPTER_BINARIES,
  ADAPTER_INSTALL_HINTS,
  ADAPTER_LOGIN_HINTS,
  notFoundError,
} from "./adapters.ts";
import type { AdapterName } from "./types.ts";

describe("adapter metadata", () => {
  const ALL: AdapterName[] = ["claude-code", "codex", "cursor"];

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
