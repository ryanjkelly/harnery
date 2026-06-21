/**
 * Shared types for the generic <LogTable> abstraction used by both /events
 * and /live. Each page brings its own per-event-shape renderer; the table
 * itself is event-shape-agnostic.
 *
 * Why a per-row renderer instead of pre-built LogRow objects: /live receives
 * events over SSE as raw JSON. Sharing one renderer config across the
 * initial server-rendered batch + the streamed appends keeps both code paths
 * producing identical rows, and lets the client own the React rendering.
 */

import type { ReactNode } from "react";

export type LogRowVariant =
  | "info"
  | "success"
  | "destructive"
  | "accent"
  | "warning"
  | "secondary"
  | "muted";

/**
 * Adapter that lifts an opaque event shape into the fields the shared
 * <LogTable> needs. All getters are pure and synchronous; the table calls
 * them once per row per render. Search-text is computed up-front so the
 * filter input doesn't have to traverse raw data on every keystroke.
 *
 * **No `getId`**: LogTable assigns its own React-key per row via a
 * useRef'd WeakMap keyed by event object identity. Content-derived keys
 * looked unique in the abstract but collided in practice (e.g. two `output`
 * events at the same ms with the same first-N chars of `line`). Identity
 * keys never collide and stay stable across renders.
 */
export interface LogRowRenderer<E> {
  getTs: (e: E) => string;
  getKind: (e: E) => string;
  getKindVariant: (e: E) => LogRowVariant;
  getAgentName: (e: E) => string | null;
  getAgentInstanceId: (e: E) => string | null;
  /** Rich JSX for the summary cell. Word-wraps; renders inline. */
  renderSummary: (e: E) => ReactNode;
  /** Pre-flattened text for the search filter. */
  getSearchableText: (e: E) => string;
  /** Raw object for the expand-row JSON view. May be a copy with `tool_input`
   * pre-parsed back to an object so the colorized view shows structure
   * instead of an escaped string. */
  getRaw: (e: E) => unknown;
  /**
   * Optional run-folding key. When provided, the table collapses *maximal
   * contiguous runs* of adjacent rows that share the same non-null key into a
   * single expandable group row (preview + count, click to expand the full
   * block). Return `null` for any row that must always stand alone (anchors
   * like `command_start`/`command_end`, narration, etc.).
   *
   * Used by /live to fold a command's per-line `output` events: each stdout
   * line is its own ndjson record, but they share a `cmd_id` and arrive
   * contiguously, so they belong to one logical output block. /events passes
   * no `getGroupKey` and renders every row discretely (current behavior).
   *
   * Folding runs on the already-sorted+filtered row list, so a search that
   * hides some lines of a block naturally shrinks that block's count.
   */
  getGroupKey?: (e: E) => string | null;
}
