import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { colorJson } from "./format.ts";

function rendered(value: unknown): unknown {
  return JSON.parse(stripVTControlCharacters(colorJson(value)));
}

// A broken toJSON guard can loop synchronously, beyond Bun's test timeout.
function renderedInChild(expression: string): unknown {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import { colorJson } from ${JSON.stringify(new URL("./format.ts", import.meta.url).href)};
       import { stripVTControlCharacters } from "node:util";
       process.stdout.write(stripVTControlCharacters(colorJson(${expression})));`,
    ],
    { encoding: "utf8", timeout: 2000, windowsHide: true },
  );
  if (result.error) throw result.error;
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
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
    expect(
      renderedInChild(`(() => {
        const value = { value: 1, toJSON() { return this; } };
        Object.defineProperty(value, "toJSON", { enumerable: false });
        return value;
      })()`),
    ).toEqual({ value: 1 });
  });

  test("handles a cycle introduced by toJSON and keeps scalar conversions", () => {
    expect(renderedInChild("({ toJSON() { return { source: this }; } })")).toEqual({
      source: "[Circular]",
    });
    expect(rendered(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z");
  });
});
