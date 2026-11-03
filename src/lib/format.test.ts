import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { colorJson } from "./format.ts";

function rendered(value: unknown): unknown {
  return JSON.parse(stripVTControlCharacters(colorJson(value)));
}

describe("colorJson reference handling", () => {
  test("renders shared objects and arrays at each noncircular reference", () => {
    const object = { value: 1 };
    const array = [object];
    const value = { first: object, second: object, arrays: [array, array] };
    expect(rendered(value)).toEqual(value);
  });

  test("marks actual object and array cycles without hiding later references", () => {
    const object: { value: number; self?: unknown } = { value: 1 };
    object.self = object;
    const array: unknown[] = [];
    array.push(array);
    expect(rendered([object, object, array, array])).toEqual([
      { value: 1, self: "[Circular]" },
      { value: 1, self: "[Circular]" },
      ["[Circular]"],
      ["[Circular]"],
    ]);
  });

  test("handles toJSON returning itself without overflowing the stack", () => {
    const value = {
      value: 1,
      toJSON() {
        return this;
      },
    };
    Object.defineProperty(value, "toJSON", { enumerable: false });
    expect(rendered(value)).toEqual({ value: 1 });
  });

  test("handles a cycle introduced by toJSON and keeps scalar conversions", () => {
    const value = {
      toJSON() {
        return { source: this };
      },
    };
    expect(rendered(value)).toEqual({ source: "[Circular]" });
    expect(rendered(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
  });
});
