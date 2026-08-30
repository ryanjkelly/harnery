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
  pingFlight: string;
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

const PING_TRAVEL_MS = 4_200;
const PING_IMPACT_MS = 1_650;
const ENDPOINT_HOLD_MS: Record<CodecEffectKind, number> = {
  ping: 6_200,
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
  };

  const finish = (effectId: string): void => {
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
    armEndpoint(
      sourceId,
      { kind: "ping", role: "source", phase: "charge", label: "Pinging", peerName: targetName },
      ENDPOINT_HOLD_MS.ping,
    );
    armEndpoint(
      cue.targetInstanceId,
      {
        kind: "ping",
        role: "target",
        phase: options.reducedMotion() ? "impact" : "incoming",
        label: options.reducedMotion() ? "Received from" : "Incoming from",
        peerName: sourceName,
      },
      ENDPOINT_HOLD_MS.ping,
    );
    if (options.reducedMotion() || options.layer.ownerDocument.visibilityState === "hidden") {
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

    const start = edgeAnchor(sourceRect, targetRect);
    const end = edgeAnchor(targetRect, sourceRect);
    const flight = element(
      options.layer,
      "div",
      `${options.classes.root} ${options.classes.pingFlight}`,
    );
    flight.dataset.codecEffect = cue.id;
    flight.dataset.effectKind = "ping";
    flight.style.left = `${start.x}px`;
    flight.style.top = `${start.y}px`;
    flight.style.setProperty("--fx-x", `${end.x - start.x}px`);
    flight.style.setProperty("--fx-y", `${end.y - start.y}px`);
    flight.style.setProperty("--fx-angle", `${Math.atan2(end.y - start.y, end.x - start.x)}rad`);
    const core = element(flight, "span", options.classes.pingCore);
    const label = element(core, "span", options.classes.pingLabel);
    label.textContent = "PING";
    options.layer.appendChild(flight);
    rememberNode(cue.id, flight);

    later(cue.id, PING_TRAVEL_MS, () => {
      flight.remove();
      effectNodes.get(cue.id)?.delete(flight);
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
      const impact = createImpact(options, cue, end.x, end.y, "RECEIVED");
      rememberNode(cue.id, impact);
      later(cue.id, PING_IMPACT_MS, () => finish(cue.id));
    });
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
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const root = element(
      options.layer,
      "div",
      `${options.classes.root} ${options.classes.targetEffect} ${kindClass(options.classes, cue.kind)}`,
    );
    root.dataset.codecEffect = cue.id;
    root.dataset.effectKind = cue.kind;
    root.style.left = `${centerX}px`;
    root.style.top = `${centerY}px`;
    root.style.setProperty("--fx-card-width", `${Math.min(rect.width, 560)}px`);
    root.style.setProperty("--fx-card-height", `${Math.min(rect.height, 420)}px`);
    element(root, "span", options.classes.ring);
    if (cue.kind === "power-up") element(root, "span", options.classes.beam);
    const label = element(root, "span", options.classes.label);
    label.textContent = endpoint.label.toUpperCase();
    addParticles(root, options.classes.particle, cue);
    options.layer.appendChild(root);
    rememberNode(cue.id, root);
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
    cancelAll() {
      for (const effectId of effectNodes.keys()) removeEffectNodes(effectId);
      for (const timers of effectTimers.values()) for (const timer of timers) clearTimeout(timer);
      effectTimers.clear();
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

function edgeAnchor(rect: DOMRect, toward: DOMRect): { x: number; y: number } {
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const vectorX = toward.left + toward.width / 2 - centerX;
  const vectorY = toward.top + toward.height / 2 - centerY;
  const inset = 10;
  const xScale = Math.abs(vectorX) > 0 ? (rect.width / 2 - inset) / Math.abs(vectorX) : Infinity;
  const yScale = Math.abs(vectorY) > 0 ? (rect.height / 2 - inset) / Math.abs(vectorY) : Infinity;
  const scale = Math.min(xScale, yScale);
  return { x: centerX + vectorX * scale, y: centerY + vectorY * scale };
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
  impact.style.left = `${x}px`;
  impact.style.top = `${y}px`;
  const label = element(impact, "span", options.classes.label);
  label.textContent = text;
  options.layer.appendChild(impact);
  return impact;
}
