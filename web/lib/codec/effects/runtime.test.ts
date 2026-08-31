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

  test("keeps zero-distance geometry finite", () => {
    const geometry = measurePingGeometry(
      { left: 10, top: 20, width: 100, height: 80 },
      { left: 10, top: 20, width: 100, height: 80 },
    );

    expect(geometry).toMatchObject({
      start: { x: 60, y: 60 },
      end: { x: 60, y: 60 },
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
      scaleX: 0.28,
      scaleY: 0.28,
      trailLength: 0,
      trailOpacity: 0,
    });
    expect(measurePingFlightFrame(geometry, 0.28)).toMatchObject({
      x: 0,
      y: 0,
      opacity: 1,
      scaleX: 1.12,
      scaleY: 1.12,
      trailLength: 0,
      trailOpacity: 0,
    });
  });

  test("accelerates through the guide and stretches into a warp streak", () => {
    const earlyFrame = measurePingFlightFrame(geometry, 0.46);
    const lateFrame = measurePingFlightFrame(geometry, 0.82);

    expect(earlyFrame.x).toBeCloseTo(25);
    expect(earlyFrame.y).toBeCloseTo(18.75);
    expect(lateFrame.x).toBeCloseTo(225);
    expect(lateFrame.y).toBeCloseTo(168.75);
    expect(lateFrame.scaleX).toBeGreaterThan(earlyFrame.scaleX);
    expect(lateFrame.scaleY).toBeLessThan(earlyFrame.scaleY);
    expect(lateFrame.trailLength).toBeGreaterThan(earlyFrame.trailLength);
    expect(lateFrame.trailOpacity).toBeGreaterThan(earlyFrame.trailOpacity);
  });

  test("lands exactly on the target center", () => {
    expect(measurePingFlightFrame(geometry, 1)).toEqual({
      x: 400,
      y: 300,
      opacity: 1,
      scaleX: 2.226,
      scaleY: 0.6048,
      trailLength: 332,
      trailOpacity: 1,
    });
  });
});
