import { describe, expect, test } from "bun:test";

import { formatBytes, formatFileSize } from "./bytes";

describe("byte formatters", () => {
  test("formatFileSize uses B, KB, and MB with one decimal", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(3482)).toBe("3.4 KB");
    expect(formatFileSize(12 * 1024 * 1024)).toBe("12.0 MB");
  });

  test("formatBytes uses binary units and reads null as Unknown", () => {
    expect(formatBytes(null)).toBe("Unknown");
    expect(formatBytes(812)).toBe("812 B");
    expect(formatBytes(4.2 * 1024 ** 3)).toBe("4.2 GiB");
    expect(formatBytes(17 * 1024 ** 4)).toBe("17 TiB");
  });
});
