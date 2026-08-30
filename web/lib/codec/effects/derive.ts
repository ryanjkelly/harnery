import type { CodecPanelScene, CodecScene, CodecTransient } from "../contracts";
import type { CodecEffectCue, CodecEffectPreview } from "./contracts";

interface DeriveCodecEffectsOptions {
  seenTransientIds?: ReadonlySet<string>;
}

/** Translate truthful scene changes into presentation-only effect requests.
 * Initial snapshots never call this with animation enabled, so opening Codec
 * cannot manufacture a celebration from old state. */
export function deriveCodecEffects(
  previous: CodecScene,
  next: CodecScene,
  options: DeriveCodecEffectsOptions = {},
): CodecEffectCue[] {
  const cues: CodecEffectCue[] = [];
  const seen = options.seenTransientIds ?? new Set<string>();

  for (const transient of next.transients) {
    if (seen.has(transient.cue_id)) continue;
    const cue = effectForTransient(transient);
    if (cue) cues.push(cue);
  }

  const previousPanels = new Map(previous.panels.map((panel) => [panel.instance_id, panel]));
  for (const panel of next.panels) {
    const prior = previousPanels.get(panel.instance_id);
    if (!prior) continue;
    const cue = effectForPanelChange(prior, panel);
    if (cue) cues.push(cue);
  }

  return cues;
}

export function effectForPreview(preview: CodecEffectPreview): CodecEffectCue {
  return {
    id: `preview:${preview.kind}:${preview.sequence}`,
    kind: preview.kind,
    targetInstanceId: preview.targetInstanceId,
    ...(preview.sourceInstanceId ? { sourceInstanceId: preview.sourceInstanceId } : {}),
    priority: preview.kind === "ping" || preview.kind === "healing" ? 3 : 2,
  };
}

function effectForTransient(transient: CodecTransient): CodecEffectCue | undefined {
  if (transient.kind === "message") {
    if (!transient.from_instance_id || !transient.to_instance_id) return undefined;
    return {
      id: `transient:${transient.cue_id}`,
      kind: "ping",
      sourceInstanceId: transient.from_instance_id,
      targetInstanceId: transient.to_instance_id,
      priority: 3,
    };
  }

  if (transient.kind === "dependency-completed" && transient.to_instance_id) {
    return {
      id: `transient:${transient.cue_id}`,
      kind: "power-up",
      targetInstanceId: transient.to_instance_id,
      ...(transient.from_instance_id ? { sourceInstanceId: transient.from_instance_id } : {}),
      priority: 3,
    };
  }
  return undefined;
}

function effectForPanelChange(
  previous: CodecPanelScene,
  next: CodecPanelScene,
): CodecEffectCue | undefined {
  const targetInstanceId = next.instance_id;
  const recoveredTelemetry =
    previous.telemetry?.value === "degraded" && next.telemetry?.value === "healthy";
  const recoveredLifecycle =
    previous.lifecycle.value === "blocked" && next.lifecycle.value === "active";
  if (recoveredTelemetry || recoveredLifecycle) {
    return {
      id: `healing:${targetInstanceId}:${next.updated_at}`,
      kind: "healing",
      targetInstanceId,
      priority: 3,
    };
  }

  if (previous.presence.value !== "online" && next.presence.value === "online") {
    return {
      id: `power-up:${targetInstanceId}:${next.updated_at}`,
      kind: "power-up",
      targetInstanceId,
      priority: 2,
    };
  }

  const priorActionIds = new Set(previous.recent_actions.map((action) => action.event_id));
  const completedAction = next.recent_actions.find(
    (action) => action.outcome === "ok" && !priorActionIds.has(action.event_id),
  );
  const resumedWork = previous.activity.value !== "working" && next.activity.value === "working";
  if (next.telemetry?.value !== "degraded" && (completedAction || resumedWork)) {
    return {
      id: completedAction
        ? `energy:${targetInstanceId}:${completedAction.event_id}`
        : `energy:${targetInstanceId}:${next.updated_at}`,
      kind: "energy",
      targetInstanceId,
      priority: 1,
    };
  }

  return undefined;
}
