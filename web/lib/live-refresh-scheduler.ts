export interface LiveRefreshSchedulerDeps {
  now: () => number;
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface LiveRefreshScheduler {
  request(): void;
  cancel(): void;
}

/**
 * Pages backed by the complete coordination projection are deliberately
 * expensive: they validate and reduce the append-only ledger. During active
 * agent work that ledger changes several times per tool call, so refreshing
 * once per change turns one browser tab into a continuous rebuild loop.
 */
export const HEAVY_REFRESH_INTERVAL_MS = 120_000;
export const LIGHT_REFRESH_INTERVAL_MS = 30_000;

const SELF_LIVE_ROUTES = ["/browse", "/codec", "/diagnostics", "/images", "/live", "/resources"];
const HEAVY_ROUTES = [
  "/agents",
  "/councils",
  "/decisions",
  "/events",
  "/governors",
  "/work",
  "/workflows",
];

function matchesRoute(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/**
 * Return null for pages that fold their own live stream into client state.
 * Other pages retain global live updates, but complete-ledger pages use a much
 * wider refresh window than lightweight file and utility pages.
 */
export function liveRefreshIntervalMs(pathname: string): number | null {
  if (SELF_LIVE_ROUTES.some((route) => matchesRoute(pathname, route))) return null;
  if (pathname === "/" || HEAVY_ROUTES.some((route) => matchesRoute(pathname, route))) {
    return HEAVY_REFRESH_INTERVAL_MS;
  }
  return LIGHT_REFRESH_INTERVAL_MS;
}

/**
 * Leading-cooldown, trailing-edge coalescer for router.refresh(). The initial
 * server render starts the first cooldown, so a ledger write immediately after
 * mount cannot trigger a duplicate render. Once the window expires, any number
 * of queued signals become exactly one refresh.
 */
export function createLiveRefreshScheduler(
  refresh: () => void,
  minIntervalMs: number,
  deps: LiveRefreshSchedulerDeps,
): LiveRefreshScheduler {
  let lastRefreshAt = deps.now();
  let timer: unknown;
  let pending = false;
  let cancelled = false;

  const flush = () => {
    timer = undefined;
    if (cancelled || !pending) return;
    pending = false;
    lastRefreshAt = deps.now();
    refresh();
  };

  return {
    request() {
      if (cancelled) return;
      pending = true;
      const remaining = Math.max(0, minIntervalMs - (deps.now() - lastRefreshAt));
      if (remaining === 0) {
        if (timer !== undefined) deps.clearTimeout(timer);
        flush();
        return;
      }
      if (timer === undefined) timer = deps.setTimeout(flush, remaining);
    },
    cancel() {
      cancelled = true;
      pending = false;
      if (timer !== undefined) deps.clearTimeout(timer);
      timer = undefined;
    },
  };
}
