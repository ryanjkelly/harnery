import type { CodecScene } from "../contracts";
import { CodecEffectBudget } from "./budget";
import type {
  CodecEffectCue,
  CodecEffectEndpoint,
  CodecEffectKind,
  CodecEffectRuntimeHandle,
} from "./contracts";

export interface CodecEffectClassNames {
  root: string;
  pingLaunch: string;
  pingPath: string;
  pingFlight: string;
  pingStreak: string;
  pingCore: string;
  pingLabel: string;
  impact: string;
  targetEffect: string;
  energy: string;
  powerUp: string;
  healing: string;
  ring: string;
  beam: string;
  particle: string;
  label: string;
}

export interface CodecEffectRuntimeOptions {
  layer: HTMLElement;
  anchorRoot: HTMLElement;
  classes: CodecEffectClassNames;
  onEndpointChange: (instanceId: string, endpoint: CodecEffectEndpoint | null) => void;
  onAnnouncement: (message: string) => void;
  reducedMotion: () => boolean;
  maxConcurrent: () => number;
}

const PING_TRAVEL_MS = 2_850;
const PING_MAX_FRAME_DELTA_MS = 64;
const PING_TRAVEL_FALLBACK_MS = 30_000;
const PING_IMPACT_MS = 1_100;
const ENDPOINT_HOLD_MS: Record<CodecEffectKind, number> = {
  ping: 5_200,
  energy: 2_800,
  "power-up": 3_200,
  healing: 3_400,
};
const TARGET_EFFECT_MS: Record<Exclude<CodecEffectKind, "ping">, number> = {
  energy: 2_600,
  "power-up": 3_000,
  healing: 3_200,
};

export function createCodecEffectRuntime(
  options: CodecEffectRuntimeOptions,
): CodecEffectRuntimeHandle {
  const budget = new CodecEffectBudget({ maxConcurrent: options.maxConcurrent(), seenLimit: 500 });
  const effectNodes = new Map<string, Set<HTMLElement>>();
  const effectTimers = new Map<string, Set<ReturnType<typeof setTimeout>>>();
  const effectAnimationFrames = new Map<string, number>();
  const effectLayoutRefreshers = new Map<string, Set<() => void>>();
  const endpointTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const activeEndpoints = new Set<string>();

  const resolveAnchor = (instanceId: string): HTMLElement | null => {
    for (const node of options.anchorRoot.querySelectorAll<HTMLElement>(
      "[data-codec-effect-anchor]",
    )) {
      if (node.dataset.codecEffectAnchor === instanceId) return node;
    }
    return null;
  };

  const rememberNode = (effectId: string, node: HTMLElement): void => {
    const nodes = effectNodes.get(effectId) ?? new Set<HTMLElement>();
    nodes.add(node);
    effectNodes.set(effectId, nodes);
  };

  const rememberLayoutRefresher = (effectId: string, refresher: () => void): void => {
    const refreshers = effectLayoutRefreshers.get(effectId) ?? new Set<() => void>();
    refreshers.add(refresher);
    effectLayoutRefreshers.set(effectId, refreshers);
  };

  const later = (effectId: string, delay: number, fn: () => void): void => {
    const timer = setTimeout(() => {
      effectTimers.get(effectId)?.delete(timer);
      fn();
    }, delay);
    const timers = effectTimers.get(effectId) ?? new Set<ReturnType<typeof setTimeout>>();
    timers.add(timer);
    effectTimers.set(effectId, timers);
  };

  const removeEffectNodes = (effectId: string): void => {
    for (const node of effectNodes.get(effectId) ?? []) node.remove();
    effectNodes.delete(effectId);
    effectLayoutRefreshers.delete(effectId);
  };

  const finish = (effectId: string): void => {
    const frame = effectAnimationFrames.get(effectId);
    if (frame !== undefined) options.layer.ownerDocument.defaultView?.cancelAnimationFrame(frame);
    effectAnimationFrames.delete(effectId);
    removeEffectNodes(effectId);
    for (const timer of effectTimers.get(effectId) ?? []) clearTimeout(timer);
    effectTimers.delete(effectId);
    budget.finish(effectId);
  };

  const armEndpoint = (instanceId: string, endpoint: CodecEffectEndpoint, holdMs: number): void => {
    const prior = endpointTimers.get(instanceId);
    if (prior) clearTimeout(prior);
    activeEndpoints.add(instanceId);
    options.onEndpointChange(instanceId, endpoint);
    endpointTimers.set(
      instanceId,
      setTimeout(() => {
        options.onEndpointChange(instanceId, null);
        endpointTimers.delete(instanceId);
        activeEndpoints.delete(instanceId);
      }, holdMs),
    );
  };

  const playPing = (cue: CodecEffectCue, scene: CodecScene): void => {
    const sourceId = cue.sourceInstanceId;
    if (!sourceId) {
      finish(cue.id);
      return;
    }
    const sourceName = nameOf(scene, sourceId);
    const targetName = nameOf(scene, cue.targetInstanceId);
    const reducedMotion = options.reducedMotion();
    armEndpoint(
      sourceId,
      {
        kind: "ping",
        role: "source",
        phase: reducedMotion ? "impact" : "charge",
        label: reducedMotion ? "Sent to" : "Pinging",
        peerName: targetName,
      },
      ENDPOINT_HOLD_MS.ping,
    );
    armEndpoint(
      cue.targetInstanceId,
      {
        kind: "ping",
        role: "target",
        phase: reducedMotion ? "impact" : "incoming",
        label: reducedMotion ? "Received from" : "Incoming from",
        peerName: sourceName,
      },
      ENDPOINT_HOLD_MS.ping,
    );
    if (reducedMotion || options.layer.ownerDocument.visibilityState === "hidden") {
      later(cue.id, ENDPOINT_HOLD_MS.ping, () => finish(cue.id));
      return;
    }

    const source = resolveAnchor(sourceId);
    const target = resolveAnchor(cue.targetInstanceId);
    if (!source || !target) {
      later(cue.id, ENDPOINT_HOLD_MS.ping, () => finish(cue.id));
      return;
    }
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    if (
      !rectVisible(sourceRect, options.layer.ownerDocument.defaultView) ||
      !rectVisible(targetRect, options.layer.ownerDocument.defaultView)
    ) {
      later(cue.id, ENDPOINT_HOLD_MS.ping, () => finish(cue.id));
      return;
    }

    const path = element(
      options.layer,
      "div",
      `${options.classes.root} ${options.classes.pingPath}`,
    );
    const launch = element(
      options.layer,
      "div",
      `${options.classes.root} ${options.classes.pingLaunch}`,
    );
    const flight = element(
      options.layer,
      "div",
      `${options.classes.root} ${options.classes.pingFlight}`,
    );
    for (const [node, phase] of [
      [path, "route"],
      [launch, "launch"],
      [flight, "flight"],
    ] as const) {
      node.dataset.codecEffect = cue.id;
      node.dataset.effectKind = "ping";
      node.dataset.effectPhase = phase;
      node.dataset.sourceInstance = sourceId;
      node.dataset.targetInstance = cue.targetInstanceId;
      rememberNode(cue.id, node);
    }
    let geometry = measurePingGeometry(sourceRect, targetRect);
    const refreshFlight = () => {
      const currentSource = resolveAnchor(sourceId);
      const currentTarget = resolveAnchor(cue.targetInstanceId);
      if (!currentSource || !currentTarget) return;
      const currentSourceRect = currentSource.getBoundingClientRect();
      const currentTargetRect = currentTarget.getBoundingClientRect();
      if (
        !rectVisible(currentSourceRect, options.layer.ownerDocument.defaultView) ||
        !rectVisible(currentTargetRect, options.layer.ownerDocument.defaultView)
      ) {
        return;
      }
      geometry = measurePingGeometry(currentSourceRect, currentTargetRect);
      setPingGeometry(path, geometry);
      setPingGeometry(launch, geometry);
      setPingGeometry(flight, geometry);
    };
    refreshFlight();
    setPingFlightFrame(flight, measurePingFlightFrame(geometry, 0));
    const streak = element(flight, "span", options.classes.pingStreak);
    streak.dataset.effectVisual = "ping-warp-streak";
    const core = element(flight, "span", options.classes.pingCore);
    core.dataset.effectVisual = "ping-orb";
    const label = element(flight, "span", options.classes.pingLabel);
    label.textContent = "PING";
    rememberLayoutRefresher(cue.id, refreshFlight);

    let flightCompleted = false;
    const completeFlight = () => {
      if (flightCompleted) return;
      flightCompleted = true;
      const activeFrame = effectAnimationFrames.get(cue.id);
      if (activeFrame !== undefined) {
        options.layer.ownerDocument.defaultView?.cancelAnimationFrame(activeFrame);
      }
      effectAnimationFrames.delete(cue.id);
      for (const node of [path, launch, flight]) {
        node.remove();
        effectNodes.get(cue.id)?.delete(node);
      }
      effectLayoutRefreshers.delete(cue.id);
      armEndpoint(
        sourceId,
        {
          kind: "ping",
          role: "source",
          phase: "impact",
          label: "Sent to",
          peerName: targetName,
        },
        PING_IMPACT_MS + 700,
      );
      armEndpoint(
        cue.targetInstanceId,
        {
          kind: "ping",
          role: "target",
          phase: "impact",
          label: "Received from",
          peerName: sourceName,
        },
        PING_IMPACT_MS + 700,
      );
      const impact = createImpact(options, cue, geometry.end.x, geometry.end.y, "RECEIVED");
      const refreshImpact = () => {
        const currentSource = resolveAnchor(sourceId);
        const currentTarget = resolveAnchor(cue.targetInstanceId);
        if (!currentSource || !currentTarget) return;
        const currentEnd = measurePingGeometry(
          currentSource.getBoundingClientRect(),
          currentTarget.getBoundingClientRect(),
        ).end;
        impact.style.left = `${currentEnd.x}px`;
        impact.style.top = `${currentEnd.y}px`;
      };
      rememberNode(cue.id, impact);
      rememberLayoutRefresher(cue.id, refreshImpact);
      later(cue.id, PING_IMPACT_MS, () => finish(cue.id));
    };
    const view = options.layer.ownerDocument.defaultView;
    if (!view) {
      completeFlight();
      return;
    }
    let elapsed = 0;
    let previousFrame: number | null = null;
    const advanceFlight = (timestamp: number) => {
      if (flightCompleted) return;
      if (previousFrame !== null) {
        elapsed += Math.min(Math.max(timestamp - previousFrame, 0), PING_MAX_FRAME_DELTA_MS);
      }
      previousFrame = timestamp;
      const progress = Math.min(elapsed / PING_TRAVEL_MS, 1);
      setPingFlightFrame(flight, measurePingFlightFrame(geometry, progress));
      if (progress >= 1) {
        completeFlight();
        return;
      }
      effectAnimationFrames.set(cue.id, view.requestAnimationFrame(advanceFlight));
    };
    effectAnimationFrames.set(cue.id, view.requestAnimationFrame(advanceFlight));
    // A frame-based clock prevents a dense debug page from converting one
    // long dropped frame into a teleport. Keep a distant safety cleanup for a
    // visible document whose animation frames are suppressed entirely.
    later(cue.id, PING_TRAVEL_FALLBACK_MS, completeFlight);
  };

  const playTargetEffect = (
    cue: CodecEffectCue & { kind: Exclude<CodecEffectKind, "ping"> },
  ): void => {
    const endpoint = endpointFor(cue.kind);
    armEndpoint(cue.targetInstanceId, endpoint, ENDPOINT_HOLD_MS[cue.kind]);
    if (options.reducedMotion() || options.layer.ownerDocument.visibilityState === "hidden") {
      later(cue.id, ENDPOINT_HOLD_MS[cue.kind], () => finish(cue.id));
      return;
    }
    const anchor = resolveAnchor(cue.targetInstanceId);
    if (!anchor) {
      later(cue.id, ENDPOINT_HOLD_MS[cue.kind], () => finish(cue.id));
      return;
    }
    const rect = anchor.getBoundingClientRect();
    if (!rectVisible(rect, options.layer.ownerDocument.defaultView)) {
      later(cue.id, ENDPOINT_HOLD_MS[cue.kind], () => finish(cue.id));
      return;
    }
    const root = element(
      options.layer,
      "div",
      `${options.classes.root} ${options.classes.targetEffect} ${kindClass(options.classes, cue.kind)}`,
    );
    root.dataset.codecEffect = cue.id;
    root.dataset.effectKind = cue.kind;
    const refreshTarget = () => {
      const currentAnchor = resolveAnchor(cue.targetInstanceId);
      if (!currentAnchor) return;
      const currentRect = currentAnchor.getBoundingClientRect();
      if (!rectVisible(currentRect, options.layer.ownerDocument.defaultView)) return;
      root.style.left = `${currentRect.left + currentRect.width / 2}px`;
      root.style.top = `${currentRect.top + currentRect.height / 2}px`;
      root.style.setProperty("--fx-card-width", `${Math.min(currentRect.width, 560)}px`);
      root.style.setProperty("--fx-card-height", `${Math.min(currentRect.height, 420)}px`);
    };
    refreshTarget();
    element(root, "span", options.classes.ring);
    if (cue.kind === "power-up") element(root, "span", options.classes.beam);
    const label = element(root, "span", options.classes.label);
    label.textContent = endpoint.label.toUpperCase();
    addParticles(root, options.classes.particle, cue);
    options.layer.appendChild(root);
    rememberNode(cue.id, root);
    rememberLayoutRefresher(cue.id, refreshTarget);
    later(cue.id, TARGET_EFFECT_MS[cue.kind], () => finish(cue.id));
  };

  return {
    play(cue, scene) {
      if (!budget.start(cue)) return false;
      options.onAnnouncement(announcementFor(cue, scene));
      if (cue.kind === "ping") playPing(cue, scene);
      else playTargetEffect(cue as CodecEffectCue & { kind: Exclude<CodecEffectKind, "ping"> });
      return true;
    },
    playMany(cues, scene) {
      return [...cues]
        .sort((a, b) => b.priority - a.priority)
        .reduce((count, cue) => count + (this.play(cue, scene) ? 1 : 0), 0);
    },
    refreshLayout() {
      for (const refreshers of effectLayoutRefreshers.values()) {
        for (const refresh of refreshers) refresh();
      }
    },
    cancelAll() {
      for (const frame of effectAnimationFrames.values()) {
        options.layer.ownerDocument.defaultView?.cancelAnimationFrame(frame);
      }
      effectAnimationFrames.clear();
      for (const effectId of effectNodes.keys()) removeEffectNodes(effectId);
      for (const timers of effectTimers.values()) for (const timer of timers) clearTimeout(timer);
      effectTimers.clear();
      effectLayoutRefreshers.clear();
      for (const timer of endpointTimers.values()) clearTimeout(timer);
      endpointTimers.clear();
      for (const instanceId of activeEndpoints) options.onEndpointChange(instanceId, null);
      activeEndpoints.clear();
      budget.clearActive();
    },
  };
}

function endpointFor(kind: Exclude<CodecEffectKind, "ping">): CodecEffectEndpoint {
  if (kind === "healing") {
    return { kind, role: "target", phase: "impact", label: "Recovered" };
  }
  if (kind === "power-up") {
    return { kind, role: "target", phase: "impact", label: "Powering up" };
  }
  return { kind, role: "target", phase: "impact", label: "Energy gained" };
}

function announcementFor(cue: CodecEffectCue, scene: CodecScene): string {
  const target = nameOf(scene, cue.targetInstanceId);
  if (cue.kind === "ping") {
    return `agent-${nameOf(scene, cue.sourceInstanceId)} pinged agent-${target}`;
  }
  if (cue.kind === "healing") return `agent-${target} recovered`;
  if (cue.kind === "power-up") return `agent-${target} powered up`;
  return `agent-${target} completed work and gained energy`;
}

function nameOf(scene: CodecScene, instanceId: string | undefined): string {
  return (
    scene.panels.find((panel) => panel.instance_id === instanceId)?.identity.display_name ??
    "unknown"
  );
}

function element<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = parent.ownerDocument.createElement(tag);
  node.className = className;
  node.setAttribute("aria-hidden", "true");
  parent.appendChild(node);
  return node;
}

function addParticles(root: HTMLElement, className: string, cue: CodecEffectCue): void {
  const count = cue.kind === "power-up" ? 14 : cue.kind === "healing" ? 12 : 9;
  const seed = stableHash(cue.id);
  for (let index = 0; index < count; index += 1) {
    const particle = element(root, "i", className);
    particle.style.setProperty("--fx-i", String(index));
    particle.style.setProperty("--fx-angle", `${(seed + index * 137.5) % 360}deg`);
    particle.style.setProperty("--fx-distance", `${34 + ((seed + index * 17) % 58)}px`);
    particle.style.setProperty("--fx-delay", `${(index % 5) * 70}ms`);
    particle.style.setProperty("--fx-drift", `${-42 + ((seed + index * 29) % 84)}px`);
    if (cue.kind === "healing" && index % 4 === 0) particle.textContent = "+";
  }
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function kindClass(classes: CodecEffectClassNames, kind: Exclude<CodecEffectKind, "ping">): string {
  if (kind === "power-up") return classes.powerUp;
  return classes[kind];
}

function rectVisible(rect: DOMRect, view: Window | null): boolean {
  if (!view || rect.width <= 0 || rect.height <= 0) return false;
  return (
    rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight
  );
}

type PingRect = Pick<DOMRect, "left" | "top" | "width" | "height">;

export interface PingGeometry {
  start: { x: number; y: number };
  end: { x: number; y: number };
  delta: { x: number; y: number };
  angle: number;
  distance: number;
}

export interface PingFlightFrame {
  x: number;
  y: number;
  opacity: number;
  scaleX: number;
  scaleY: number;
  trailLength: number;
  trailOpacity: number;
}

/** The ping is a relationship between whole cards, so both anchors are their
 * visual centers and the flight follows the straight delta between them. */
export function measurePingGeometry(source: PingRect, target: PingRect): PingGeometry {
  const start = { x: source.left + source.width / 2, y: source.top + source.height / 2 };
  const end = { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  const delta = { x: end.x - start.x, y: end.y - start.y };
  const distance = Math.hypot(delta.x, delta.y);
  const angle = Math.atan2(delta.y, delta.x);
  return { start, end, delta, angle, distance };
}

/** Advances by painted frames instead of wall time so a delayed frame cannot
 * skip the projectile from its launch state directly to impact. */
export function measurePingFlightFrame(
  geometry: PingGeometry,
  rawProgress: number,
): PingFlightFrame {
  const progress = Math.min(Math.max(rawProgress, 0), 1);
  const chargeEnd = 0.28;
  const chargeProgress = Math.min(progress / chargeEnd, 1);
  const travelProgress = Math.max((progress - chargeEnd) / (1 - chargeEnd), 0);
  const positionProgress = travelProgress ** 2;
  const warpIntensity = travelProgress ** 1.35;
  const chargeScale =
    chargeProgress < 0.62
      ? 0.28 + (chargeProgress / 0.62) * (0.94 - 0.28)
      : 0.94 + ((chargeProgress - 0.62) / 0.38) * (1.12 - 0.94);
  const flightScale = 1.12 + warpIntensity * (0.84 - 1.12);
  return {
    x: geometry.delta.x * positionProgress,
    y: geometry.delta.y * positionProgress,
    opacity: Math.min(progress / 0.08, 1),
    scaleX: travelProgress > 0 ? flightScale * (1 + warpIntensity * 1.65) : chargeScale,
    scaleY: travelProgress > 0 ? flightScale * (1 - warpIntensity * 0.28) : chargeScale,
    trailLength: travelProgress > 0 ? 32 + warpIntensity * 300 : 0,
    trailOpacity:
      travelProgress > 0 ? Math.min(travelProgress / 0.22, 1) * (0.42 + warpIntensity * 0.58) : 0,
  };
}

function setPingFlightFrame(node: HTMLElement, frame: PingFlightFrame): void {
  node.style.opacity = `${frame.opacity}`;
  node.style.transform = `translate(${frame.x}px, ${frame.y}px)`;
  node.style.setProperty("--fx-orb-scale-x", `${frame.scaleX}`);
  node.style.setProperty("--fx-orb-scale-y", `${frame.scaleY}`);
  node.style.setProperty("--fx-warp-trail-length", `${frame.trailLength}px`);
  node.style.setProperty("--fx-warp-trail-opacity", `${frame.trailOpacity}`);
}

function setPingGeometry(node: HTMLElement, geometry: PingGeometry): void {
  node.style.left = `${geometry.start.x}px`;
  node.style.top = `${geometry.start.y}px`;
  node.style.setProperty("--fx-x", `${geometry.delta.x}px`);
  node.style.setProperty("--fx-y", `${geometry.delta.y}px`);
  node.style.setProperty("--fx-angle", `${geometry.angle}rad`);
  node.style.setProperty("--fx-distance", `${geometry.distance}px`);
}

function createImpact(
  options: CodecEffectRuntimeOptions,
  cue: CodecEffectCue,
  x: number,
  y: number,
  text: string,
): HTMLElement {
  const impact = element(options.layer, "div", `${options.classes.root} ${options.classes.impact}`);
  impact.dataset.codecEffect = cue.id;
  impact.dataset.effectKind = cue.kind;
  impact.dataset.effectPhase = "impact";
  if (cue.sourceInstanceId) impact.dataset.sourceInstance = cue.sourceInstanceId;
  impact.dataset.targetInstance = cue.targetInstanceId;
  impact.style.left = `${x}px`;
  impact.style.top = `${y}px`;
  const label = element(impact, "span", options.classes.label);
  label.textContent = text;
  options.layer.appendChild(impact);
  return impact;
}
