/**
 * Where an agent's own windows go (ADR 0251): the placement type and its
 * defaults. Pure data with no process or file access, so the config reader
 * and the dashboard can import it.
 *
 * Internal module: not exported from package.json.
 */

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const CORNERS: readonly Corner[] = ["top-left", "top-right", "bottom-left", "bottom-right"];

/** Where an agent's own windows go. */
export interface WindowPlacement {
  /** "secondary" (first display that is not primary), "primary", a 1-based index, or a display id. */
  display: string;
  corner: Corner;
  /** Requested size; absent means the smallest the program allows. */
  width?: number;
  height?: number;
  /** Gap from the display's work-area edges. */
  margin: number;
}

export const DEFAULT_PLACEMENT: WindowPlacement = {
  display: "secondary",
  corner: "bottom-right",
  margin: 0,
};

/** The size asked for when a placement names none; programs clamp it to their own minimum. */
export const SMALLEST_REQUEST = { width: 100, height: 100 } as const;
