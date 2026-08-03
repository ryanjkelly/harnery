import { resolveCoordRoot } from "./coord-client.ts";

/**
 * Resolve the coordination root.
 *
 * Delegates to `resolveCoordRoot()`. This was a third, independent copy of the
 * walk-up — the kind of duplication that let the hooks and the CLI drift onto
 * different roots in the first place; keep resolution in one place.
 */
export function findCoordRoot(start: string = process.cwd()): string | null {
  return resolveCoordRoot(start);
}
