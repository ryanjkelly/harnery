import { describe, expect, test } from "bun:test";
import { type CodecLayoutInput, deriveCodecLayout } from "./layout";

const BASE: CodecLayoutInput = {
  panelCount: 3,
  viewportWidth: 1_600,
  viewportHeight: 900,
  stageWidth: 880,
  rootFontSize: 16,
  remotePanelOpen: true,
  teamPanelOpen: true,
  fullscreen: false,
  mode: "live",
};

function layout(overrides: Partial<CodecLayoutInput> = {}) {
  return deriveCodecLayout({ ...BASE, ...overrides });
}

describe("Codec layout director", () => {
  test.each([
    {
      name: "empty stage",
      input: { panelCount: 0 },
      expected: { composition: "empty", viewport: "desktop", rows: 0, columns: 0 },
    },
    {
      name: "mobile deck",
      input: { panelCount: 5, viewportWidth: 720, stageWidth: 690 },
      expected: { composition: "mobile-deck", viewport: "mobile", rows: 5, columns: 1 },
    },
    {
      name: "tablet featured grid",
      input: { viewportWidth: 900, viewportHeight: 1_200, stageWidth: 870 },
      expected: { composition: "featured", viewport: "tablet", rows: 2, columns: 2 },
    },
    {
      name: "desktop featured grid below the height threshold",
      input: { viewportHeight: 895 },
      expected: { composition: "featured", viewport: "desktop", rows: 2, columns: 2 },
    },
    {
      name: "balanced rows at the exact geometry thresholds",
      input: {},
      expected: {
        composition: "balanced-two-row",
        viewport: "desktop",
        rows: 2,
        columns: 2,
      },
    },
    {
      name: "featured grid one pixel below the balanced width",
      input: { stageWidth: 879 },
      expected: { composition: "featured", viewport: "desktop", rows: 2, columns: 2 },
    },
    {
      name: "dense desktop grid",
      input: { panelCount: 6, viewportHeight: 895, stageWidth: 1_200 },
      expected: { composition: "dense", viewport: "desktop", rows: 3, columns: 2 },
    },
    {
      name: "five-card balanced grid",
      input: { panelCount: 5, stageWidth: 1_328 },
      expected: {
        composition: "balanced-two-row",
        viewport: "desktop",
        rows: 2,
        columns: 3,
      },
    },
  ])("chooses $name", ({ input, expected }) => {
    expect(layout(input)).toMatchObject(expected);
  });

  test("returns the card height, centering, and overflow policies", () => {
    expect(layout()).toMatchObject({
      cardHeight: "fit-two-rows",
      centering: "last-row",
      bodyOverflow: "card",
    });
    expect(layout({ panelCount: 4 })).toMatchObject({
      centering: "none",
      bodyOverflow: "card",
    });
    expect(layout({ viewportWidth: 900 })).toMatchObject({
      cardHeight: "content",
      centering: "last-card",
      bodyOverflow: "page",
    });
  });

  test("changes the geometry key for mode and presentation state without changing policy", () => {
    const base = layout();
    for (const changed of [
      layout({ remotePanelOpen: false }),
      layout({ teamPanelOpen: false }),
      layout({ fullscreen: true }),
      layout({ mode: "replay" }),
    ]) {
      expect(changed).toMatchObject({
        composition: base.composition,
        rows: base.rows,
        columns: base.columns,
      });
      expect(changed.geometryKey).not.toBe(base.geometryKey);
    }
  });

  test.each([
    {
      name: "three cards in the mobile lab preset",
      input: { panelCount: 3, viewportWidth: 390, viewportHeight: 844, stageWidth: 360 },
      expected: { composition: "mobile-deck", rows: 3, columns: 1 },
    },
    {
      name: "four cards in the tablet lab preset",
      input: { panelCount: 4, viewportWidth: 900, viewportHeight: 900, stageWidth: 870 },
      expected: { composition: "featured", rows: 2, columns: 2 },
    },
    {
      name: "five cards in the short desktop lab preset",
      input: { panelCount: 5, viewportWidth: 1_600, viewportHeight: 760, stageWidth: 1_200 },
      expected: { composition: "dense", rows: 3, columns: 2 },
    },
    {
      name: "six cards in the tall desktop lab preset",
      input: { panelCount: 6, viewportWidth: 1_920, viewportHeight: 960, stageWidth: 1_328 },
      expected: { composition: "balanced-two-row", rows: 2, columns: 3 },
    },
    {
      name: "eight cards on the tall desktop canvas with side panels closed",
      input: {
        panelCount: 8,
        viewportWidth: 1_920,
        viewportHeight: 960,
        stageWidth: 1_776,
        remotePanelOpen: false,
        teamPanelOpen: false,
      },
      expected: { composition: "balanced-two-row", rows: 2, columns: 4 },
    },
  ])("pins $name", ({ input, expected }) => {
    expect(layout(input)).toMatchObject(expected);
  });
});
