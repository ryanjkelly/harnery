import { describe, expect, test } from "bun:test";
import { measurePingGeometry } from "./runtime";

describe("measurePingGeometry", () => {
  test("anchors the flight to the exact center of both cards", () => {
    const geometry = measurePingGeometry(
      { left: 100, top: 40, width: 320, height: 240 },
      { left: 620, top: 180, width: 440, height: 300 },
    );

    expect(geometry.start).toEqual({ x: 260, y: 160 });
    expect(geometry.end).toEqual({ x: 840, y: 330 });
    expect(geometry.delta).toEqual({ x: 580, y: 170 });
    expect(geometry.distance).toBeCloseTo(Math.hypot(580, 170));
    expect(geometry.angle).toBeCloseTo(Math.atan2(170, 580));
  });

  test("bows the readable midpoint without moving either endpoint", () => {
    const geometry = measurePingGeometry(
      { left: 0, top: 0, width: 200, height: 200 },
      { left: 500, top: 0, width: 200, height: 200 },
    );

    expect(geometry.start).toEqual({ x: 100, y: 100 });
    expect(geometry.end).toEqual({ x: 600, y: 100 });
    expect(geometry.midpoint.x).toBe(250);
    expect(geometry.midpoint.y).toBeGreaterThan(0);
    expect(geometry.midpoint.y).toBeLessThanOrEqual(46);
  });

  test("keeps zero-distance geometry finite", () => {
    const geometry = measurePingGeometry(
      { left: 10, top: 20, width: 100, height: 80 },
      { left: 10, top: 20, width: 100, height: 80 },
    );

    expect(geometry).toMatchObject({
      start: { x: 60, y: 60 },
      end: { x: 60, y: 60 },
      midpoint: { x: 0, y: 0 },
      delta: { x: 0, y: 0 },
      angle: 0,
      distance: 0,
    });
  });
});
