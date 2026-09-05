"use client";

import { createContext, useSyncExternalStore } from "react";

const KEY = "files:autoplay-videos";
const EVENT = "files:autoplay-videos-changed";
let fallback = true;
export type VideoSelection = { path: string; action: "open" | "play" | "pause"; sequence: number };
export const VideoSelectionContext = createContext<VideoSelection | null>(null);
export type VideoPlayback = { path: string; playing: boolean };
export const VideoPlaybackContext = createContext<(state: VideoPlayback | null) => void>(() => {});

export function videoAutoplayEnabled(): boolean {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === null ? fallback : stored !== "false";
  } catch {
    return fallback;
  }
}
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(EVENT, callback);
  };
}
export function VideoAutoplayToggle() {
  const enabled = useSyncExternalStore(subscribe, videoAutoplayEnabled, () => true);
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
      <input
        type="checkbox"
        role="switch"
        aria-checked={enabled}
        checked={enabled}
        onChange={(event) => {
          fallback = event.target.checked;
          try {
            localStorage.setItem(KEY, String(event.target.checked));
          } catch {
            /* Optional storage. */
          }
          window.dispatchEvent(new Event(EVENT));
        }}
        className="size-4 accent-emerald-500"
      />
      Autoplay videos
    </label>
  );
}
