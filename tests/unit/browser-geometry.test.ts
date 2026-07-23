import { describe, expect, test } from "bun:test";
import { intersectRects, type LayoutRect, median } from "../../src/lib/browser/geometry.ts";

const rect = (left: number, top: number, width: number, height: number): LayoutRect => ({
  x: left,
  y: top,
  width,
  height,
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe("browser geometry primitives", () => {
  test("median is stable for odd, even, and empty populations", () => {
    expect(median([])).toBe(0);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([10, 2, 6, 4])).toBe(5);
  });

  test("rectangle intersection rejects edge contact and returns positive area", () => {
    expect(intersectRects(rect(0, 0, 10, 10), rect(10, 0, 5, 5))).toBeNull();
    expect(intersectRects(rect(0, 0, 10, 10), rect(6, 4, 8, 8))).toEqual(rect(6, 4, 4, 6));
  });
});
