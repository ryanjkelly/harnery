"use client";

import { DEFAULT_BIN_NAME, type HostInfo } from "@/lib/config";
import { type ReactNode, createContext, useContext } from "react";

/**
 * Pushes server-resolved {@link HostInfo} (host bin name + coord root) into the
 * client tree. Mounted once at the root in [`app/layout.tsx`](../app/layout.tsx)
 * with the value read by [`hostInfo()`](../lib/config.ts). Client components read
 * it via {@link useHostInfo} / {@link useBinName} so agent-facing command strings
 * + path display match the *host* project (`harn …`) rather than hardcoding it.
 *
 * Safe outside the provider: falls back to `{ binName: "harn", repoRoot: "" }`
 * so storybook / isolated component tests don't need the wrapper.
 */
const HostInfoContext = createContext<HostInfo | null>(null);

export function HostInfoProvider({ value, children }: { value: HostInfo; children: ReactNode }) {
  return <HostInfoContext.Provider value={value}>{children}</HostInfoContext.Provider>;
}

export function useHostInfo(): HostInfo {
  return useContext(HostInfoContext) ?? { binName: DEFAULT_BIN_NAME, repoRoot: "" };
}

/** Convenience for the common case: just the host bin name. */
export function useBinName(): string {
  return useHostInfo().binName;
}
