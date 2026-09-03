import { describe, expect, test } from "bun:test";
import { PNG } from "pngjs";
import {
  CAPTURE_FIDELITY_MISMATCH_THRESHOLD,
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

test("native comparison detects displaced thin rules erased by quarter-scale averaging", () => {
  const a = image(80, 80, (x) => (x % 4 === 0 ? 0 : 255));
  const b = image(80, 80, (x) => (x % 4 === 1 ? 0 : 255));
  expect(compareBand(a, b).exceeds).toBe(true);
  const quarter = (src: PNG) => {
    const out = image(src.width / 4, src.height / 4);
    for (let y = 0; y < out.height; y++)
      for (let x = 0; x < out.width; x++) {
        let sum = 0;
        for (let j = 0; j < 4; j++)
          for (let i = 0; i < 4; i++) sum += src.data[((y * 4 + j) * src.width + x * 4 + i) * 4];
        const n = (y * out.width + x) * 4;
        out.data[n] = out.data[n + 1] = out.data[n + 2] = Math.round(sum / 16);
      }
    return out;
  };
  expect(compareBand(quarter(a), quarter(b)).mismatch_ratio).toBe(0);
});
