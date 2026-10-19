"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

import { AttentionFlow } from "@/components/AttentionFlow";
import {
  type AttentionRequest,
  ensureAudioUnlocked,
  isAcked,
  LAST_REQUEST_STORAGE_KEY,
  markAcked,
  parseStoredRequest,
  startChime,
  startFaviconDot,
  startTitleFlash,
} from "@/lib/attention";
import { ATTENTION_POLL_MS, createAttentionClient } from "@/lib/attention-client";

/**
 * Root provider for the operator-attention system (mounted once in the app
 * layout, like LiveRefresher). Pages declare "this state waits on the human"
 * by mounting `<Attention request={{ key, label }}>` (components/Attention.tsx);
 * this provider drives the channels (title flash, favicon dot, chime, plus
 * the viewport edge pulse and the cursor→target flow lines it renders itself)
 * and silences everything on the operator's first DELIBERATE interaction
 * (click/tap, or a keystroke while a form field is focused — scrolling and
 * stray keys don't ack), recording the key in sessionStorage so
 * `router.refresh()` re-renders never re-alarm a moment the operator already
 * acknowledged.
 *
 * Replay: the most recent alert (whether acked or expired) is kept in state +
 * sessionStorage; `replay()` re-fires its channels on demand (the NavBar bell),
 * bypassing both the acked-dedup and the engaged suppression, since the
 * operator explicitly asked to see it again. Elements inside `[data-attention-replay]`
 * are exempt from ack-on-interaction so clicking the bell doesn't instantly
 * silence the alert it just fired.
 *
 * Single slot: one request at a time, last mounted leaf wins. Every page in
 * this app renders at most one actionable next-step, so a registry would be
 * speculative. Revisit if a page ever needs two concurrent alerts.
 *
 * The server selects one fresh client and grants a short recipient lease.
 * Every tab keeps its in-page event; only the selected client starts automatic
 * title/favicon/chime channels. The grant carries server-observed engagement,
 * so a focused tab with stale interaction cannot suppress another client.
 */

type AttentionState = {
  /** The page's declared request (null = nothing actionable). */
  request: AttentionRequest | null;
  /** True while an un-acked (or replayed) alert is live. */
  isAlerting: boolean;
  /** What the replay bell would fire: the most recent alert this session,
   * falling back to the page's current request (covers "the moment was acked
   * before this tab ever alerted", e.g. a reload onto an already-seen state). */
  replayTarget: AttentionRequest | null;
  /** Acknowledge + silence the current alert (interactions do this for you). */
  ack: () => void;
  /** Re-fire the replay target's channels (forces past acked/engaged). */
  replay: () => void;
};

const noop = () => {};
const StateCtx = createContext<AttentionState>({
  request: null,
  isAlerting: false,
  replayTarget: null,
  ack: noop,
  replay: noop,
});
const SlotCtx = createContext<(r: AttentionRequest | null) => void>(noop);

/** Read-only alert state. For example, the council prompt panel pulses its
 * active chip + Copy button while `isAlerting`. Inert defaults outside the provider. */
export function useAttentionState(): AttentionState {
  return useContext(StateCtx);
}

/** Internal: the `<Attention>` leaf's write channel. */
export function useAttentionSlot(): (r: AttentionRequest | null) => void {
  return useContext(SlotCtx);
}

export function AttentionProvider({ children }: { children: React.ReactNode }) {
  const [slot, setSlotState] = useState<AttentionRequest | null>(null);
  const slotRef = useRef<AttentionRequest | null>(null);
  const setSlot = useCallback((r: AttentionRequest | null) => {
    slotRef.current = r;
    setSlotState(r);
  }, []);
  /** Non-null while channels are live (the alerting request). */
  const [alert, setAlert] = useState<AttentionRequest | null>(null);
  const [lastRequest, setLastRequest] = useState<AttentionRequest | null>(null);
  const lastRequestRef = useRef<AttentionRequest | null>(null);
  const interaction = useRef(0);
  const clientRef = useRef<ReturnType<typeof createAttentionClient> | null>(null);
  const observeRef = useRef<() => void>(noop);
  /** Stops the out-of-band channels of whatever alert is currently live. */
  const stopRef = useRef<() => void>(noop);
  const ackRef = useRef<() => void>(noop);

  // Seed the replay bell from sessionStorage so it survives a reload.
  useEffect(() => {
    try {
      const stored = parseStoredRequest(sessionStorage.getItem(LAST_REQUEST_STORAGE_KEY));
      if (stored) {
        lastRequestRef.current = stored;
        setLastRequest(stored);
      }
    } catch {
      /* private mode: bell just starts empty */
    }
  }, []);

  const startAlert = useCallback(
    (request: AttentionRequest, opts: { disruptive?: boolean; force?: boolean } = {}) => {
      stopRef.current(); // restore title/favicon from any prior alert first

      const channels = {
        title: true,
        favicon: true,
        audio: true,
        edge: true,
        flow: true,
        ...request.channels,
      };
      const stops: Array<() => void> = [];
      if (opts.force || opts.disruptive) {
        if (channels.title) stops.push(startTitleFlash(request.label));
        if (channels.favicon) stops.push(startFaviconDot());
        if (channels.audio) stops.push(startChime(request.audioRepeat));
      }
      const stopAll = () => {
        for (const stop of stops) stop();
        stopRef.current = noop;
      };
      stopRef.current = stopAll;
      ackRef.current = () => {
        markAcked(request.key);
        void clientRef.current?.acknowledge();
        stopAll();
        setAlert(null);
        ackRef.current = noop;
      };
      setAlert(request);
      lastRequestRef.current = request;
      setLastRequest(request);
      try {
        sessionStorage.setItem(
          LAST_REQUEST_STORAGE_KEY,
          JSON.stringify({ key: request.key, label: request.label }),
        );
      } catch {
        /* best-effort persistence */
      }
    },
    [],
  );

  useEffect(() => {
    const client = createAttentionClient({
      clientId: crypto.randomUUID(),
      onGrant: (grant) => {
        const request = slotRef.current;
        if (request?.key !== grant.eventKey) return;
        if (isAcked(request.key)) {
          void client.acknowledge();
          return;
        }
        startAlert(request, { disruptive: !grant.engaged });
      },
      onStop: () => stopRef.current(),
      onAcknowledged: (eventKey) => {
        const request = slotRef.current;
        if (request?.key !== eventKey) return;
        markAcked(request.key);
        stopRef.current();
        ackRef.current = noop;
        setAlert(null);
      },
    });
    clientRef.current = client;
    const observe = () => {
      const key = slotRef.current?.key;
      void client
        .observe({
          eventKey: slotRef.current?.key ?? null,
          visible: document.visibilityState === "visible",
          focused: document.hasFocus(),
          interaction: interaction.current,
        })
        .then(() => {
          if (key && slotRef.current?.key === key && isAcked(key)) void client.acknowledge();
        });
    };
    observeRef.current = observe;
    const interval = setInterval(observe, ATTENTION_POLL_MS);
    window.addEventListener("focus", observe);
    window.addEventListener("blur", observe);
    document.addEventListener("visibilitychange", observe);
    observe();
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", observe);
      window.removeEventListener("blur", observe);
      document.removeEventListener("visibilitychange", observe);
      observeRef.current = noop;
      clientRef.current = null;
      client.dispose();
    };
  }, [startAlert]);

  const replay = useCallback(() => {
    const request = lastRequestRef.current ?? slotRef.current;
    if (request) startAlert(request, { force: true });
  }, [startAlert]);

  // Interaction tracking: unlocks audio (autoplay policy), feeds the engaged
  // heuristic, and acks whatever is currently alerting. The replay bell is
  // exempt: its click must not ack the alert it just re-fired.
  //
  // Only DELIBERATE interactions ack: a click/tap (pointerdown) or typing
  // into a form field. Scrolling (wheel/touchstart) and stray keystrokes with
  // no form element focused still unlock audio + feed the engaged heuristic,
  // but must NOT silence the alert — reading the page isn't acknowledging it
  // (operator feedback, 2026-07-06).
  useEffect(() => {
    const isFormTarget = (el: Element | null): boolean =>
      !!el &&
      (el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement ||
        (el instanceof HTMLElement && el.isContentEditable));
    const onInteract = (e: Event) => {
      ensureAudioUnlocked();
      const target = e.target as Element | null;
      if (target?.closest?.("[data-attention-replay]")) return;
      interaction.current++;
      observeRef.current();
      if (e.type === "wheel" || e.type === "touchstart") return;
      if (e.type === "keydown" && !isFormTarget(document.activeElement)) return;
      ackRef.current();
    };
    const opts: AddEventListenerOptions = { passive: true };
    window.addEventListener("pointerdown", onInteract, opts);
    window.addEventListener("keydown", onInteract, opts);
    window.addEventListener("wheel", onInteract, opts);
    window.addEventListener("touchstart", onInteract, opts);
    return () => {
      window.removeEventListener("pointerdown", onInteract);
      window.removeEventListener("keydown", onInteract);
      window.removeEventListener("wheel", onInteract);
      window.removeEventListener("touchstart", onInteract);
    };
  }, []);

  // Slot lifecycle, keyed on the request's semantic key, not its object
  // identity: RSC refreshes hand the leaf a fresh object for the same moment
  // every few seconds, and that must not restart channels.
  const slotKey = slot?.key ?? null;
  useEffect(() => {
    observeRef.current();
    const request = slotRef.current;
    if (!request || request.key !== slotKey || isAcked(request.key)) return;
    startAlert(request);
    return () => {
      stopRef.current();
      ackRef.current = noop;
      setAlert(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key IS the identity
  }, [slotKey, startAlert]);

  const showEdge = alert !== null && (alert.channels?.edge ?? true);
  const showFlow = alert !== null && (alert.channels?.flow ?? true);

  return (
    <StateCtx.Provider
      value={{
        request: slot,
        isAlerting: alert !== null,
        replayTarget: lastRequest ?? slot,
        ack: () => ackRef.current(),
        replay,
      }}
    >
      <SlotCtx.Provider value={setSlot}>
        {showEdge && <div aria-hidden className="attention-edge" />}
        {showFlow && <AttentionFlow />}
        {children}
      </SlotCtx.Provider>
    </StateCtx.Provider>
  );
}
