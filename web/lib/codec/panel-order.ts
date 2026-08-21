import type { CodecPanelScene } from "./contracts";

/**
 * Stable visual order inside a presence section. Activity timestamps are
 * deliberately excluded so routine heartbeats and tool calls do not move a
 * card. Local panels precede remote panels, then machine/name/id break ties.
 */
export function stableCodecPanelOrder(panels: readonly CodecPanelScene[]): CodecPanelScene[] {
  return [...panels].sort((left, right) => {
    const leftRemote = left.machine ? 1 : 0;
    const rightRemote = right.machine ? 1 : 0;
    return (
      leftRemote - rightRemote ||
      (left.machine ?? "").localeCompare(right.machine ?? "", "en", { numeric: true }) ||
      left.identity.display_name.localeCompare(right.identity.display_name, "en", {
        numeric: true,
        sensitivity: "base",
      }) ||
      left.instance_id.localeCompare(right.instance_id, "en", { numeric: true })
    );
  });
}
