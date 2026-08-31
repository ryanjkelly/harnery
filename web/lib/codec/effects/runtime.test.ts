import { describe, expect, test } from "bun:test";
import { measurePingFlightFrame, measurePingGeometry } from "./runtime";

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

  test("keeps the midpoint on the straight center-to-center guide", () => {
    const geometry = measurePingGeometry(
      { left: 0, top: 0, width: 200, height: 200 },
      { left: 500, top: 0, width: 200, height: 200 },
    );

    expect(geometry.start).toEqual({ x: 100, y: 100 });
    expect(geometry.end).toEqual({ x: 600, y: 100 });
    expect(geometry.midpoint).toEqual({ x: 250, y: 0 });
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

describe("measurePingFlightFrame", () => {
  const geometry = measurePingGeometry(
    { left: 0, top: 0, width: 100, height: 100 },
    { left: 400, top: 300, width: 100, height: 100 },
  );

  test("holds the orb at the source while it charges", () => {
    expect(measurePingFlightFrame(geometry, 0)).toEqual({
      x: 0,
      y: 0,
      opacity: 0,
      scale: 0.3,
    });
    expect(measurePingFlightFrame(geometry, 0.16)).toMatchObject({
      x: 0,
      y: 0,
      opacity: 1,
      scale: 1.08,
    });
  });

  test("moves through the guide instead of jumping between endpoints", () => {
    const frame = measurePingFlightFrame(geometry, 0.58);
    expect(frame.x).toBeCloseTo(200);
    expect(frame.y).toBeCloseTo(150);
    expect(frame.opacity).toBe(1);
  });

  test("lands exactly on the target center", () => {
    expect(measurePingFlightFrame(geometry, 1)).toEqual({
      x: 400,
      y: 300,
      opacity: 1,
      scale: 0.86,
    });
  });
});
