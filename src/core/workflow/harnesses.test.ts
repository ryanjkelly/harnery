import { describe, expect, test } from "bun:test";
import {
  HARNESS_BINARIES,
  HARNESS_INSTALL_HINTS,
  HARNESS_LOGIN_HINTS,
  notFoundError,
} from "./harnesses.ts";
import type { HarnessName } from "./types.ts";

describe("harness metadata", () => {
  const ALL: HarnessName[] = ["claude-code", "codex", "cursor"];

  test("every harness has a binary, install hint, and login hint", () => {
    for (const h of ALL) {
      expect(HARNESS_BINARIES[h]).toBeTruthy();
      expect(HARNESS_INSTALL_HINTS[h]).toBeTruthy();
      expect(HARNESS_LOGIN_HINTS[h]).toBeTruthy();
    }
  });

  test("notFoundError names the binary and carries both hints", () => {
    for (const h of ALL) {
      const msg = notFoundError(h);
      expect(msg).toContain(HARNESS_BINARIES[h]);
      expect(msg).toContain(HARNESS_INSTALL_HINTS[h]);
      expect(msg).toContain(HARNESS_LOGIN_HINTS[h]);
    }
  });
});
