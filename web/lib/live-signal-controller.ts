export type LiveSignalStatus = "connecting" | "live" | "polling" | "reconnecting";

export interface LiveSignalEvent {
  type?: string;
}

export interface LiveSignalSource {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(name: string, handler: (event: LiveSignalEvent) => void): void;
  close(): void;
}

export interface LiveSignalControllerOptions {
  streamUrl: string;
  versionUrl: string;
  watchdogMs: number;
  staleMs: number;
  pollMs: number;
  maxRetries: number;
  enabled: boolean;
  fetchOnFallbackStart: boolean;
  eventNames: () => string[];
  onEvent: (name: string, event: LiveSignalEvent) => void;
  onFallbackChange: () => void;
  onStatus: (status: LiveSignalStatus) => void;
}

export interface LiveSignalControllerDeps {
  createSource: (url: string) => LiveSignalSource;
  fetchVersion: (url: string) => Promise<string | undefined>;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  visibility: () => "hidden" | "visible";
  onVisibilityChange: (callback: () => void) => () => void;
}

const RECONNECT_DELAY_MS = 1_000;

/** Testable transport state machine behind useLiveSignal. */
export function createLiveSignalController(
  options: LiveSignalControllerOptions,
  deps: LiveSignalControllerDeps,
): { start(): void; stop(): void } {
  let source: LiveSignalSource | undefined;
  let cancelled = false;
  let reconnectTimer: unknown;
  let initialWatchdog: unknown;
  let activityTimer: unknown;
  let pollTimer: unknown;
  let lastVersion: string | undefined;
  let retries = 0;
  let removeVisibility: (() => void) | undefined;

  const clear = (handle: unknown): undefined => {
    if (handle !== undefined) deps.clearTimeout(handle);
    return undefined;
  };
  const stopPolling = () => {
    if (pollTimer !== undefined) deps.clearInterval(pollTimer);
    pollTimer = undefined;
  };
  const closeStream = () => {
    reconnectTimer = clear(reconnectTimer);
    initialWatchdog = clear(initialWatchdog);
    activityTimer = clear(activityTimer);
    source?.close();
    source = undefined;
  };
  const teardown = () => {
    closeStream();
    stopPolling();
  };

  const pollOnce = async () => {
    const version = await deps.fetchVersion(options.versionUrl);
    if (cancelled || version === undefined) return;
    if (lastVersion === undefined) {
      lastVersion = version;
    } else if (version !== lastVersion) {
      lastVersion = version;
      options.onFallbackChange();
    }
  };
  const startPolling = () => {
    if (cancelled || pollTimer !== undefined) return;
    closeStream();
    options.onStatus("polling");
    lastVersion = undefined;
    if (options.fetchOnFallbackStart) options.onFallbackChange();
    void pollOnce();
    pollTimer = deps.setInterval(() => void pollOnce(), options.pollMs);
  };

  let connect: () => void;
  const scheduleReconnect = () => {
    closeStream();
    if (cancelled) return;
    options.onStatus("reconnecting");
    reconnectTimer = deps.setTimeout(connect, RECONNECT_DELAY_MS);
  };
  const markLive = () => {
    retries = 0;
    initialWatchdog = clear(initialWatchdog);
    stopPolling();
    options.onStatus("live");
    activityTimer = clear(activityTimer);
    activityTimer = deps.setTimeout(scheduleReconnect, options.staleMs);
  };

  connect = () => {
    if (!options.enabled || !options.streamUrl || cancelled || source || pollTimer !== undefined) {
      return;
    }
    if (deps.visibility() === "hidden") {
      options.onStatus("connecting");
      return;
    }
    const next = deps.createSource(options.streamUrl);
    source = next;
    next.onopen = () => {
      initialWatchdog = clear(initialWatchdog);
      initialWatchdog = deps.setTimeout(startPolling, options.watchdogMs);
    };
    for (const name of options.eventNames()) {
      next.addEventListener(name, (event) => {
        markLive();
        options.onEvent(name, event);
      });
    }
    next.addEventListener("stale", scheduleReconnect);
    next.onerror = () => {
      closeStream();
      if (cancelled) return;
      retries += 1;
      options.onStatus("reconnecting");
      if (retries >= options.maxRetries) {
        startPolling();
      } else {
        reconnectTimer = deps.setTimeout(connect, Math.min(30_000, 1_000 * 2 ** retries));
      }
    };
  };

  const onVisibility = () => {
    teardown();
    retries = 0;
    options.onStatus("connecting");
    if (deps.visibility() === "visible") connect();
  };

  return {
    start() {
      cancelled = false;
      connect();
      removeVisibility = deps.onVisibilityChange(onVisibility);
    },
    stop() {
      cancelled = true;
      removeVisibility?.();
      removeVisibility = undefined;
      teardown();
    },
  };
}
