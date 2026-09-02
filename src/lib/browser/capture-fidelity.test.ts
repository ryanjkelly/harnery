import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import {
  CAPTURE_FIDELITY_MISMATCH_THRESHOLD,
  chooseProbeBands,
  compareBand,
  decideFidelity,
  pngDimensions,
  stitchPngRows,
} from "./capture-fidelity.ts";
import { DEFAULT_REUSE_MISMATCH_RATIO } from "./qa-reuse.ts";

function image(width: number, height: number, paint?: (x: number, y: number) => number): PNG {
  const img = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = paint ? paint(x, y) : 128;
      const i = (y * width + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  return img;
}

function bands(count: number, height = 100): Array<{ id: string; scrollY: number }> {
  return Array.from({ length: count }, (_, i) => ({ id: `T${i + 1}`, scrollY: i * height }));
}

describe("chooseProbeBands", () => {
  test("picks the top band and the middle band by document position", () => {
    const picked = chooseProbeBands(bands(5));
    expect(picked.map((b) => b.id)).toEqual(["T1", "T3"]);
  });

  test("order of the input does not matter; scrollY decides", () => {
    const picked = chooseProbeBands([...bands(4)].reverse());
    expect(picked.map((b) => b.id)).toEqual(["T1", "T3"]);
  });

  test("one band probes once, two bands probe both, none probes nothing", () => {
    expect(chooseProbeBands(bands(1)).map((b) => b.id)).toEqual(["T1"]);
    expect(chooseProbeBands(bands(2)).map((b) => b.id)).toEqual(["T1", "T2"]);
    expect(chooseProbeBands([])).toEqual([]);
  });
});

describe("compareBand", () => {
  test("identical pixels agree", () => {
    const a = image(40, 30, (x, y) => (x * 7 + y * 3) % 256);
    const b = image(40, 30, (x, y) => (x * 7 + y * 3) % 256);
    const cmp = compareBand(a, b);
    expect(cmp.mismatch_ratio).toBe(0);
    expect(cmp.exceeds).toBe(false);
    expect(cmp.size_mismatch).toBe(false);
  });

  test("a blank white block in the full-page crop exceeds the threshold", () => {
    const paint = (x: number, y: number) => (x * 7 + y * 3) % 256;
    const full = image(40, 30, (x, y) => (y >= 10 && y < 20 ? 255 : paint(x, y)));
    const scrolled = image(40, 30, paint);
    const cmp = compareBand(full, scrolled);
    expect(cmp.mismatch_ratio).toBeGreaterThan(0.2);
    expect(cmp.exceeds).toBe(true);
    expect(cmp.size_mismatch).toBe(false);
  });

  test("the threshold is the band-diff reuse threshold", () => {
    expect(CAPTURE_FIDELITY_MISMATCH_THRESHOLD).toBe(DEFAULT_REUSE_MISMATCH_RATIO);
  });

  test("a size drift beyond one pixel is reported, and the shared area is still compared", () => {
    const a = image(40, 30);
    const b = image(40, 24);
    const cmp = compareBand(a, b);
    expect(cmp.size_mismatch).toBe(true);
    expect(cmp.mismatch_ratio).toBe(0);
  });

  test("a one-pixel rounding difference is not a size mismatch", () => {
    const cmp = compareBand(image(40, 30), image(40, 31));
    expect(cmp.size_mismatch).toBe(false);
  });
});

describe("decideFidelity", () => {
  test("agreement keeps the full-page source", () => {
    const fidelity = decideFidelity([
      { tile_id: "T001", scrollY: 0, height: 100, mismatch_ratio: 0 },
      { tile_id: "T003", scrollY: 200, height: 100, mismatch_ratio: 0.0005 },
    ]);
    expect(fidelity.source).toBe("full-page");
    expect(fidelity.mismatched).toEqual([]);
    expect(fidelity.probed).toHaveLength(2);
    expect(fidelity.mismatch_threshold).toBe(CAPTURE_FIDELITY_MISMATCH_THRESHOLD);
  });

  test("one probe over the threshold switches the source to scrolled bands", () => {
    const fidelity = decideFidelity(
      [
        { tile_id: "T001", scrollY: 0, height: 100, mismatch_ratio: 0 },
        { tile_id: "T003", scrollY: 200, height: 100, mismatch_ratio: 0.31 },
      ],
      0.001,
    );
    expect(fidelity.source).toBe("scrolled-bands");
    expect(fidelity.mismatched).toEqual(["T003"]);
  });

  test("no probes means no evidence against the full page", () => {
    expect(decideFidelity([]).source).toBe("full-page");
  });
});

describe("stitchPngRows", () => {
  test("joins pieces top to bottom and keeps every row in place", () => {
    const top = PNG.sync.write(image(8, 3, () => 10));
    const bottom = PNG.sync.write(image(8, 2, () => 200));
    const out = PNG.sync.read(stitchPngRows([top, bottom]));
    expect(out.width).toBe(8);
    expect(out.height).toBe(5);
    expect(out.data[0]).toBe(10);
    expect(out.data[(2 * 8 + 7) * 4]).toBe(10);
    expect(out.data[3 * 8 * 4]).toBe(200);
    expect(out.data[(4 * 8 + 7) * 4]).toBe(200);
  });

  test("a single piece is returned as is", () => {
    const only = PNG.sync.write(image(4, 4));
    expect(stitchPngRows([only])).toBe(only);
  });

  test("refuses an empty list", () => {
    expect(() => stitchPngRows([])).toThrow();
  });

  test("pngDimensions reads the header", () => {
    expect(pngDimensions(PNG.sync.write(image(13, 7)))).toEqual({ width: 13, height: 7 });
  });
});
