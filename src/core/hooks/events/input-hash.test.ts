import { describe, expect, test } from "bun:test";
import { canonicalToolInput, toolInputHash, toolTargetHash } from "./input-hash.ts";

describe("exact pre-clamp tool input hashing", () => {
  test("sorts object keys recursively while preserving array order", () => {
    expect(canonicalToolInput({ z: [{ b: 2, a: 1 }], a: true })).toBe(
      '{"a":true,"z":[{"a":1,"b":2}]}',
    );
    expect(toolInputHash("Write", { b: 2, a: 1 })).toBe(toolInputHash("Write", { a: 1, b: 2 }));
    expect(toolInputHash("Write", { a: [1, 2] })).not.toBe(toolInputHash("Write", { a: [2, 1] }));
  });

  test("distinguishes inputs whose clamped prefixes collide", () => {
    const prefix = "x".repeat(8_000);
    const first = { command: `${prefix}A` };
    const second = { command: `${prefix}B` };
    expect(JSON.stringify(first).slice(0, 8_000)).toBe(JSON.stringify(second).slice(0, 8_000));
    expect(toolInputHash("Bash", first)).not.toBe(toolInputHash("Bash", second));
  });

  test("hashes recognized targets without retaining their values", () => {
    expect(toolTargetHash("Read", { file_path: "/private/project/a.ts", offset: 1 })).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(toolTargetHash("Read", { file_path: "/private/project/a.ts", offset: 2 })).toBe(
      toolTargetHash("Read", { file_path: "/private/project/a.ts", offset: 1 }),
    );
    expect(toolTargetHash("Bash", { command: "echo hi" })).toBeUndefined();
  });
});
