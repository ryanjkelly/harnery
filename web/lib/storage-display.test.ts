import { describe, expect, test } from "bun:test";

import {
  formatReasonLabel,
  formatStorageBytes,
  storageByteHelp,
  storageReasonHelp,
  storageStateHelp,
  storageTermHelp,
} from "./storage-display";

describe("storage dashboard display", () => {
  test("uses familiar decimal units without hiding exact binary and byte values", () => {
    const bytes = 20_993_024_722;
    expect(formatStorageBytes(bytes)).toBe("20.99 GB");
    expect(storageByteHelp(bytes)).toContain("20,993,024,722 bytes");
    expect(storageByteHelp(bytes)).toContain("20.993 GB");
    expect(storageByteHelp(bytes)).toContain("19.551 GiB");
  });

  test("keeps plain-language definitions for terms, states, and reason codes", () => {
    expect(storageTermHelp("Logical footprint")).toContain("not a configured maximum");
    expect(storageStateHelp("degraded")).toContain("does not by itself mean data is lost");
    expect(storageReasonHelp("symlink_rejected")).toContain("did not follow it");
    expect(formatReasonLabel("allocated_bytes_unavailable")).toBe("allocated bytes unavailable");
  });
});
