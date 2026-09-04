export const CODEC_MOBILE_MAX_VIEWPORT_PX = 720;
export const CODEC_DESKTOP_MIN_VIEWPORT_PX = 1_200;
export const CODEC_TWO_ROW_MIN_VIEWPORT_HEIGHT_REM = 56;
export const CODEC_CARD_TARGET_WIDTH_REM = 27;
export const CODEC_GRID_GAP_REM = 1;

export type CodecViewMode = "live" | "replay" | "debug";
export type CodecLayoutViewport = "mobile" | "tablet" | "desktop";
export type CodecLayoutComposition =
  | "empty"
  | "mobile-deck"
  | "featured"
  | "balanced-two-row"
  | "dense";
export type CodecCardHeightPolicy = "content" | "fit-two-rows";
export type CodecCardCentering = "none" | "last-card" | "last-row";
export type CodecBodyOverflow = "page" | "card";

export interface CodecLayoutInput {
  panelCount: number;
  viewportWidth: number;
  viewportHeight: number;
  stageWidth: number;
  rootFontSize: number;
  remotePanelOpen: boolean;
  teamPanelOpen: boolean;
  fullscreen: boolean;
  mode: CodecViewMode;
}

export interface CodecLayout {
  composition: CodecLayoutComposition;
  viewport: CodecLayoutViewport;
  rows: number;
  columns: number;
  cardHeight: CodecCardHeightPolicy;
  centering: CodecCardCentering;
  bodyOverflow: CodecBodyOverflow;
  /** Changes whenever card geometry may have moved, even if the composition did not. */
  geometryKey: string;
}

/**
 * Chooses one named Codec composition from container facts. CSS owns the
 * placement; this policy owns only which existing placement contract applies.
 */
export function deriveCodecLayout(input: CodecLayoutInput): CodecLayout {
  const panelCount = whole(input.panelCount);
  const viewportWidth = dimension(input.viewportWidth);
  const viewportHeight = dimension(input.viewportHeight);
  const stageWidth = dimension(input.stageWidth);
  const rootFontSize = positive(input.rootFontSize, 16);
  const viewport: CodecLayoutViewport =
    viewportWidth <= CODEC_MOBILE_MAX_VIEWPORT_PX
      ? "mobile"
      : viewportWidth < CODEC_DESKTOP_MIN_VIEWPORT_PX
        ? "tablet"
        : "desktop";
  const gap = CODEC_GRID_GAP_REM * rootFontSize;
  const targetCardWidth = CODEC_CARD_TARGET_WIDTH_REM * rootFontSize;
  const balancedColumns = Math.ceil(panelCount / 2);
  const balancedWidth = balancedColumns * targetCardWidth + Math.max(0, balancedColumns - 1) * gap;
  const canFitTwoRows =
    viewport === "desktop" &&
    viewportHeight >= CODEC_TWO_ROW_MIN_VIEWPORT_HEIGHT_REM * rootFontSize;
  const balanced = panelCount >= 3 && canFitTwoRows && stageWidth >= balancedWidth;

  let composition: CodecLayoutComposition;
  let columns: number;
  let rows: number;
  let cardHeight: CodecCardHeightPolicy = "content";
  let centering: CodecCardCentering = "none";
  let bodyOverflow: CodecBodyOverflow = "page";

  if (panelCount === 0) {
    composition = "empty";
    columns = 0;
    rows = 0;
  } else if (viewport === "mobile") {
    composition = "mobile-deck";
    columns = 1;
    rows = panelCount;
  } else if (balanced) {
    composition = "balanced-two-row";
    columns = balancedColumns;
    rows = 2;
    cardHeight = "fit-two-rows";
    centering = panelCount % 2 === 1 ? "last-row" : "none";
    bodyOverflow = "card";
  } else if (panelCount <= 4) {
    composition = "featured";
    columns = Math.min(2, panelCount);
    rows = Math.ceil(panelCount / columns);
    if (viewport === "tablet" && panelCount === 3) centering = "last-card";
  } else {
    composition = "dense";
    columns =
      viewport === "tablet"
        ? Math.min(2, panelCount)
        : Math.min(
            panelCount,
            Math.max(1, Math.floor((stageWidth + gap) / (targetCardWidth + gap))),
          );
    rows = Math.ceil(panelCount / columns);
    if (viewport === "tablet" && panelCount === 5) centering = "last-card";
  }

  if (panelCount >= 3 && rows >= 2 && canFitTwoRows) {
    cardHeight = "fit-two-rows";
    bodyOverflow = "card";
  }

  return {
    composition,
    viewport,
    rows,
    columns,
    cardHeight,
    centering,
    bodyOverflow,
    geometryKey: [
      composition,
      panelCount,
      viewportWidth,
      viewportHeight,
      stageWidth,
      rootFontSize,
      input.remotePanelOpen ? "remote" : "no-remote",
      input.teamPanelOpen ? "team" : "no-team",
      input.fullscreen ? "fullscreen" : "windowed",
      input.mode,
    ].join(":"),
  };
}

function dimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function whole(value: number): number {
  return Math.floor(dimension(value));
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
