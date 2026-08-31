"use client";

import { forwardRef, type RefObject, useEffect, useImperativeHandle, useRef } from "react";
import type { CodecEffectEndpoint, CodecEffectRuntimeHandle } from "@/lib/codec/effects/contracts";
import { createCodecEffectRuntime } from "@/lib/codec/effects/runtime";
import styles from "./codecEffects.module.css";

interface CodecEffectsLayerProps {
  anchorRootRef: RefObject<HTMLElement | null>;
  onEndpointChange: (instanceId: string, endpoint: CodecEffectEndpoint | null) => void;
  onAnnouncement: (message: string) => void;
}

export const CodecEffectsLayer = forwardRef<CodecEffectRuntimeHandle, CodecEffectsLayerProps>(
  function CodecEffectsLayer({ anchorRootRef, onEndpointChange, onAnnouncement }, forwardedRef) {
    const runtimeRef = useRef<CodecEffectRuntimeHandle | null>(null);
    const endpointCallback = useRef(onEndpointChange);
    const announcementCallback = useRef(onAnnouncement);

    endpointCallback.current = onEndpointChange;
    announcementCallback.current = onAnnouncement;

    useEffect(() => {
      const anchorRoot = anchorRootRef.current;
      if (!anchorRoot) return;
      const layer = document.createElement("div");
      layer.dataset.codecEffectsLayer = "true";
      layer.className = styles.effectsLayer;
      layer.setAttribute("aria-hidden", "true");
      document.body.appendChild(layer);
      const runtime = createCodecEffectRuntime({
        layer,
        anchorRoot,
        classes: {
          root: styles.effectRoot,
          pingLaunch: styles.pingLaunch,
          pingPath: styles.pingPath,
          pingFlight: styles.pingFlight,
          pingCore: styles.pingCore,
          pingLabel: styles.pingLabel,
          impact: styles.impact,
          targetEffect: styles.targetEffect,
          energy: styles.energy,
          powerUp: styles.powerUp,
          healing: styles.healing,
          ring: styles.ring,
          beam: styles.beam,
          particle: styles.particle,
          label: styles.effectLabel,
        },
        onEndpointChange: (instanceId, endpoint) => endpointCallback.current(instanceId, endpoint),
        onAnnouncement: (message) => announcementCallback.current(message),
        reducedMotion: () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        maxConcurrent: () => (window.innerWidth <= 720 ? 2 : 6),
      });
      runtimeRef.current = runtime;
      let refreshFrame = 0;
      const refreshActiveGeometry = () => {
        if (refreshFrame) return;
        refreshFrame = window.requestAnimationFrame(() => {
          refreshFrame = 0;
          runtime.refreshLayout();
        });
      };
      const stopHiddenEffects = () => {
        if (document.visibilityState === "hidden") runtime.cancelAll();
      };
      document.addEventListener("visibilitychange", stopHiddenEffects);
      window.addEventListener("resize", refreshActiveGeometry);
      window.addEventListener("scroll", refreshActiveGeometry, true);
      return () => {
        document.removeEventListener("visibilitychange", stopHiddenEffects);
        window.removeEventListener("resize", refreshActiveGeometry);
        window.removeEventListener("scroll", refreshActiveGeometry, true);
        if (refreshFrame) window.cancelAnimationFrame(refreshFrame);
        runtime.cancelAll();
        runtimeRef.current = null;
        layer.remove();
      };
    }, [anchorRootRef]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        play: (cue, scene) => runtimeRef.current?.play(cue, scene) ?? false,
        playMany: (cues, scene) => runtimeRef.current?.playMany(cues, scene) ?? 0,
        refreshLayout: () => runtimeRef.current?.refreshLayout(),
        cancelAll: () => runtimeRef.current?.cancelAll(),
      }),
      [],
    );

    return null;
  },
);
