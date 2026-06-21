/**
 * Operator-attention engine: the page-agnostic half of the "your move" alert
 * system. When a page reaches a state that waits on the HUMAN (copy the next
 * council prompt, advance a round, …), it mounts `<Attention request>` and the
 * root `AttentionProvider` drives these channels until the operator interacts:
 *
 *   - title flash:   tab title alternates `● <label>` / original (works when
 *                    the tab is hidden or the window is unfocused)
 *   - favicon dot:   swaps the favicon for a solid sky dot (background tabs)
 *   - chime:         short two-note WebAudio cue; no asset file. Subject to
 *                    browser autoplay policy: silent until the first user
 *                    gesture unlocks the AudioContext (ensureAudioUnlocked).
 *   - edge pulse:    breathing inset ring along the viewport edges (rendered
 *                      by AttentionProvider via `.attention-edge`)
 *
 * Everything here is plain DOM/TS (no React) so it stays portable across
 * Harnery UI surfaces. All DOM-touching functions no-op under SSR.
 *
 * Acked-key dedup: each actionable moment carries a stable `key`. Once the
 * operator interacts (any pointerdown/keydown/wheel/touchstart), the key is
 * recorded in sessionStorage and never re-alerts in that tab; `router.refresh()`
 * re-renders must not re-alarm a state the operator already saw.
 */

export type AttentionChannels = {
  /** Tab-title flash. Default true. */
  title?: boolean;
  /** Favicon dot swap. Default true. */
  favicon?: boolean;
  /** WebAudio chime. Default true (still gated by mute + autoplay unlock). */
  audio?: boolean;
  /** Viewport edge pulse. Default true. */
  edge?: boolean;
  /** Cursor→target flow lines (AttentionFlow canvas). Default true. */
  flow?: boolean;
};

export type AttentionRequest = {
  /**
   * Stable identity of the actionable moment (e.g.
   * `att:<councilId>:r3:copy:agent-Astrid`). Same key = same moment: acked
   * once, never re-alerts. A new key starts a fresh alert cycle.
   */
  key: string;
  /** Short human label for the title flash ("Copy agent-Astrid's prompt"). */
  label: string;
  channels?: AttentionChannels;
  /** Chime repetition while unacked. Default: 2 plays, 45s apart. */
  audioRepeat?: { count: number; intervalMs: number };
};

/** localStorage flag a future settings toggle can set to kill all chimes. */
export const MUTE_STORAGE_KEY = "harnery.attention.muted";
const ACK_STORAGE_KEY = "harnery.attention.acked";
const ACK_TTL_MS = 24 * 60 * 60 * 1000;

/** sessionStorage slot holding the most recent alert (`{key, label}` only) so
 * the NavBar replay bell survives a reload. Channels/audioRepeat are not
 * persisted; a replay fires the default channel set. */
export const LAST_REQUEST_STORAGE_KEY = "harnery.attention.last";

/** Parse a persisted last-request payload; null on any shape mismatch. */
export function parseStoredRequest(raw: string | null): AttentionRequest | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const { key, label } = v as Record<string, unknown>;
    if (typeof key !== "string" || typeof label !== "string" || !key) return null;
    return { key, label };
  } catch {
    return null;
  }
}

/** Operator counts as "engaged" if they interacted this recently while the
 * tab is visible + focused: engaged operators get only the in-page channels
 * (edge/ring), not the chime/title (the state change is in front of them). */
export const ENGAGED_WINDOW_MS = 8_000;

// ---------------------------------------------------------------------------
// Acked-key store (sessionStorage; injectable for tests)

type AckedMap = Record<string, number>;

/** Drop entries older than the TTL. Pure, exported for tests. */
export function pruneAcked(map: AckedMap, now: number): AckedMap {
  const out: AckedMap = {};
  for (const [key, ts] of Object.entries(map)) {
    if (now - ts <= ACK_TTL_MS) out[key] = ts;
  }
  return out;
}

function defaultStore(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

export function loadAcked(store: Storage | null = defaultStore()): AckedMap {
  if (!store) return {};
  try {
    const raw = store.getItem(ACK_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const out: AckedMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function isAcked(
  key: string,
  store: Storage | null = defaultStore(),
  now: number = Date.now(),
): boolean {
  const ts = loadAcked(store)[key];
  return ts != null && now - ts <= ACK_TTL_MS;
}

export function markAcked(
  key: string,
  store: Storage | null = defaultStore(),
  now: number = Date.now(),
): void {
  if (!store) return;
  const map = pruneAcked(loadAcked(store), now);
  map[key] = now;
  try {
    store.setItem(ACK_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota/private-mode; alerts still work, dedup degrades gracefully */
  }
}

// ---------------------------------------------------------------------------
// Title flash

export function startTitleFlash(
  label: string,
  intervalMs = 1_400,
): () => void {
  if (typeof document === "undefined") return () => {};
  const original = document.title;
  let on = true;
  document.title = `● ${label}`;
  const iv = setInterval(() => {
    on = !on;
    document.title = on ? `● ${label}` : original;
  }, intervalMs);
  return () => {
    clearInterval(iv);
    document.title = original;
  };
}

// ---------------------------------------------------------------------------
// Favicon dot

/** 1×1 transparent PNG: the restore target when there was no original
 * favicon to put back. Browsers keep painting the LAST resolved icon when a
 * `<link rel=icon>` is merely removed, so removal leaves the alert dot stuck
 * on the tab; pointing the href at a transparent image actually clears it. */
const TRANSPARENT_FAVICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/**
 * Badge the current favicon with a sky alert dot (top-right, with a punch-out
 * ring so it reads at 16px). When the original favicon can't be loaded onto a
 * canvas (none exists, decode error, cross-origin taint) fall back to a
 * plain dot. Restore puts the exact original href back.
 */
export function startFaviconDot(color = "#38bdf8"): () => void {
  if (typeof document === "undefined") return () => {};
  const existing = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const originalHref = existing?.getAttribute("href") ?? null;
  const link = existing ?? document.createElement("link");
  if (!existing) {
    link.rel = "icon";
    document.head.appendChild(link);
  }
  let cancelled = false;

  const paint = (draw: (ctx: CanvasRenderingContext2D) => void) => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      draw(ctx);
      link.href = canvas.toDataURL("image/png");
    } catch {
      /* canvas unavailable/tainted; leave the favicon alone */
    }
  };
  const plainDot = (ctx: CanvasRenderingContext2D) => {
    ctx.beginPath();
    ctx.arc(32, 32, 22, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  };

  if (originalHref) {
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      paint((ctx) => {
        ctx.drawImage(img, 0, 0, 64, 64);
        ctx.beginPath();
        ctx.arc(46, 18, 16, 0, Math.PI * 2);
        ctx.fillStyle = "#09090b";
        ctx.fill();
        ctx.beginPath();
        ctx.arc(46, 18, 11, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      });
    };
    img.onerror = () => {
      if (!cancelled) paint(plainDot);
    };
    img.src = originalHref;
  } else {
    paint(plainDot);
  }

  return () => {
    cancelled = true;
    if (originalHref) link.setAttribute("href", originalHref);
    else link.setAttribute("href", TRANSPARENT_FAVICON);
  };
}

// ---------------------------------------------------------------------------
// Chime (WebAudio, no asset file, portable)

let audioCtx: AudioContext | null = null;

/**
 * Call from any user-gesture handler. Browsers refuse audio until a gesture;
 * after the first one the context stays unlocked for the page's lifetime, so
 * later alerts can chime even when they arrive while the window is unfocused.
 */
export function ensureAudioUnlocked(): void {
  if (typeof window === "undefined") return;
  try {
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

export function isAudioMuted(): boolean {
  try {
    return (
      typeof localStorage !== "undefined" &&
      localStorage.getItem(MUTE_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

/** Soft two-note ding (E6-ish pair, ~0.6s total) at modest volume. */
function playChimeOnce(volume = 0.14): void {
  if (!audioCtx) return;
  if (audioCtx.state === "suspended") {
    // Resume is async; a replay fired from the same gesture that unlocked the
    // context would otherwise race it and stay silent. Play once running.
    void audioCtx.resume().then(() => {
      if (audioCtx?.state === "running") scheduleChime(volume);
    });
    return;
  }
  if (audioCtx.state !== "running") return;
  scheduleChime(volume);
}

function scheduleChime(volume: number): void {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + 0.01;
  for (const [i, freq] of [880, 1318.5].entries()) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    const start = t0 + i * 0.13;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + 0.55);
  }
}

export function startChime(
  repeat: { count: number; intervalMs: number } = {
    count: 2,
    intervalMs: 45_000,
  },
): () => void {
  if (typeof window === "undefined" || isAudioMuted()) return () => {};
  playChimeOnce();
  let played = 1;
  const iv = setInterval(() => {
    if (played >= repeat.count) {
      clearInterval(iv);
      return;
    }
    playChimeOnce();
    played += 1;
  }, repeat.intervalMs);
  return () => clearInterval(iv);
}

// ---------------------------------------------------------------------------
// Engagement

/**
 * True when the operator is demonstrably looking at the page right now:
 * visible + focused + interacted within ENGAGED_WINDOW_MS. Engaged operators
 * skip the out-of-band channels (title/favicon/chime); the in-page edge/ring
 * still render and auto-ack on their next interaction.
 */
export function isEngaged(
  lastInteractionTs: number,
  now: number = Date.now(),
): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.visibilityState === "visible" &&
    document.hasFocus() &&
    now - lastInteractionTs < ENGAGED_WINDOW_MS
  );
}
