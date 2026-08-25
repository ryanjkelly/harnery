/**
 * Process-wide Codec scene service.
 *
 * One dashboard process may have several Codec tabs open. They share one
 * scene builder, one set of filesystem watchers, and one refresh timer. The
 * singleton lives on globalThis so Next development route bundles and HMR do
 * not accidentally create a service per route or per module instance.
 */

import fs from "node:fs";

import type { CodecScene } from "./contracts";
import { buildScene, eventsFilePaths } from "./scene-source";

const SCENE_REFRESH_MS = 5_000;
const GLOBAL_SERVICE_KEY = "__harneryCodecSceneServiceV1" as const;

interface CodecSceneSubscriber {
  ready: boolean;
  onScene: (scene: CodecScene) => void;
  onStale: () => void;
}

interface CodecSceneServiceState {
  scene?: CodecScene;
  signature: string;
  builtAtMs: number;
  buildStartedAtMs: number;
  building?: Promise<CodecScene>;
  dirty: boolean;
  pendingTimer: ReturnType<typeof setTimeout> | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  watchers: fs.FSWatcher[];
  subscribers: Set<CodecSceneSubscriber>;
  build: () => Promise<CodecScene>;
  eventPaths: () => string[];
  watch: typeof fs.watch;
  refreshMs: number;
}

export interface CodecSceneConnection {
  snapshot: CodecScene;
  close: () => void;
}

export interface CodecSceneService {
  getScene: () => Promise<CodecScene>;
  connect: (
    onScene: (scene: CodecScene) => void,
    onStale: () => void,
  ) => Promise<CodecSceneConnection>;
  refresh: () => Promise<CodecScene>;
  close: () => void;
}

export interface CodecSceneServiceOptions {
  build?: () => Promise<CodecScene>;
  eventPaths?: () => string[];
  watch?: typeof fs.watch;
  refreshMs?: number;
}

function freshState(options: CodecSceneServiceOptions): CodecSceneServiceState {
  return {
    signature: "",
    builtAtMs: 0,
    buildStartedAtMs: 0,
    dirty: false,
    pendingTimer: null,
    pollTimer: null,
    watchers: [],
    subscribers: new Set(),
    build: options.build ?? buildScene,
    eventPaths: options.eventPaths ?? eventsFilePaths,
    watch: options.watch ?? fs.watch,
    refreshMs: options.refreshMs ?? SCENE_REFRESH_MS,
  };
}

/** Ignore timestamps that change on every projection when deciding whether a
 * stream needs another complete scene payload. */
function sceneSignature(scene: CodecScene): string {
  const { generated_at: _generatedAt, freshness: _freshness, ...stable } = scene;
  return JSON.stringify(stable);
}

function notifyStale(state: CodecSceneServiceState): void {
  for (const subscriber of state.subscribers) {
    if (subscriber.ready) subscriber.onStale();
  }
}

function scheduleBuild(state: CodecSceneServiceState): void {
  if (state.pendingTimer) return;
  const lastRefreshAtMs = Math.max(state.builtAtMs, state.buildStartedAtMs);
  const wait = Math.max(0, state.refreshMs - (Date.now() - lastRefreshAtMs));
  state.pendingTimer = setTimeout(() => {
    state.pendingTimer = null;
    void currentScene(state).catch(() => {
      // Subscribers received a stale signal. The next watcher or poll retries.
    });
  }, wait);
}

async function rebuildScene(state: CodecSceneServiceState): Promise<CodecScene> {
  if (state.building) {
    state.dirty = true;
    return state.building;
  }

  state.buildStartedAtMs = Date.now();
  state.dirty = false;
  const pending = state
    .build()
    .then((scene) => {
      const signature = sceneSignature(scene);
      const changed = signature !== state.signature;
      state.scene = scene;
      state.signature = signature;
      state.builtAtMs = Date.now();
      if (changed) {
        for (const subscriber of state.subscribers) {
          if (subscriber.ready) subscriber.onScene(scene);
        }
      }
      return scene;
    })
    .catch((error: unknown) => {
      notifyStale(state);
      throw error;
    })
    .finally(() => {
      state.building = undefined;
      if (state.dirty && state.subscribers.size > 0) {
        state.dirty = false;
        scheduleBuild(state);
      }
    });
  state.building = pending;
  return pending;
}

async function currentScene(state: CodecSceneServiceState): Promise<CodecScene> {
  if (state.scene && Date.now() - state.builtAtMs <= state.refreshMs) {
    return state.scene;
  }
  return rebuildScene(state);
}

function startService(state: CodecSceneServiceState): void {
  if (state.pollTimer) return;

  for (const filePath of state.eventPaths()) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const watcher = state.watch(filePath, () => scheduleBuild(state));
      watcher.on("error", () => {
        notifyStale(state);
        watcher.close();
        state.watchers = state.watchers.filter((candidate) => candidate !== watcher);
      });
      state.watchers.push(watcher);
    } catch {
      notifyStale(state);
    }
  }

  state.pollTimer = setInterval(() => scheduleBuild(state), state.refreshMs);
}

function stopService(state: CodecSceneServiceState): void {
  if (state.subscribers.size > 0) return;
  for (const watcher of state.watchers.splice(0)) watcher.close();
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  if (state.pendingTimer) clearTimeout(state.pendingTimer);
  state.pendingTimer = null;
  state.dirty = false;
}

function closeService(state: CodecSceneServiceState): void {
  state.subscribers.clear();
  stopService(state);
}

/** Build an isolated service. Runtime uses one global instance; tests can
 * inject a deterministic builder without touching the filesystem. */
export function createCodecSceneService(options: CodecSceneServiceOptions = {}): CodecSceneService {
  const state = freshState(options);
  return {
    getScene: () => currentScene(state),
    refresh: () => rebuildScene(state),
    close: () => closeService(state),
    async connect(onScene, onStale) {
      const subscriber: CodecSceneSubscriber = { ready: false, onScene, onStale };
      state.subscribers.add(subscriber);
      startService(state);

      try {
        const snapshot = await currentScene(state);
        subscriber.ready = true;
        let closed = false;
        return {
          snapshot,
          close() {
            if (closed) return;
            closed = true;
            state.subscribers.delete(subscriber);
            stopService(state);
          },
        };
      } catch (error) {
        state.subscribers.delete(subscriber);
        stopService(state);
        throw error;
      }
    },
  };
}

function sharedService(): CodecSceneService {
  const processGlobal = globalThis as typeof globalThis & {
    [GLOBAL_SERVICE_KEY]?: CodecSceneService;
  };
  processGlobal[GLOBAL_SERVICE_KEY] ??= createCodecSceneService();
  return processGlobal[GLOBAL_SERVICE_KEY];
}

/** Return one coalesced scene for server-rendered pages and polling fallback. */
export async function getSharedCodecScene(): Promise<CodecScene> {
  return sharedService().getScene();
}

/** Join the singleton live scene service. Every connection gets one snapshot;
 * later changed scenes are multicast from the shared builder. */
export async function connectSharedCodecScene(
  onScene: (scene: CodecScene) => void,
  onStale: () => void,
): Promise<CodecSceneConnection> {
  return sharedService().connect(onScene, onStale);
}
