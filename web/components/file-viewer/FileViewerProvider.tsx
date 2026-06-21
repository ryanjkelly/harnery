"use client";

/**
 * Base-bundle entry point for the universal file viewer.
 *
 * Mounted ONCE in the root layout (alongside AttentionProvider). What ships in
 * the base bundle is deliberately tiny: this provider, `useFileViewer`, and the
 * `<FilePath>` button. The overlay shell + renderer registry + every heavy
 * engine (Shiki, react-markdown, yaml) live behind the `React.lazy` boundary
 * below, so a page that never opens a file pays ~nothing.
 *
 * URL / Back coupling implements the decision table verbatim:
 *   a  every open() writes ?path=<rel> on the CURRENT pathname (never navigates
 *      to /files): pushState on a fresh open, replaceState on replace-in-place.
 *   b  in-sequence ←/→ is replaceState only, one history entry per overlay
 *      session, so browser Back CLOSES the overlay, never steps prev/next.
 *   c  Esc/backdrop/X close: history.back() if this session pushed; else
 *      replaceState stripping ?path (the refresh/direct-link landing).
 *   d  refresh on any page with ?path= → auto-open on mount.
 *
 * The URL is read/written via the History API + a popstate listener, NOT
 * next/navigation's useSearchParams. That hook forces the whole subtree into
 * client rendering behind a Suspense boundary and would erode the base-bundle
 * target. window.location reads run only in effects (client-only), so SSR is
 * unaffected.
 */

import type { FileViewerState, OpenOptions } from "@/lib/file-viewer/types";
import {
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const FileViewerOverlay = lazy(() => import("./FileViewerOverlay"));

interface FileViewerApi {
  open: (path: string, opts?: OpenOptions) => void;
}

const FileViewerContext = createContext<FileViewerApi | null>(null);

/** Read the `path` query param from the live URL (client-only). */
function readPathParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("path");
}

/** Build a URL string for the current location with `path` set or removed,
 * preserving every other query param. */
function urlWithPath(path: string | null): string {
  const u = new URL(window.location.href);
  if (path === null) u.searchParams.delete("path");
  else u.searchParams.set("path", path);
  return `${u.pathname}${u.search}${u.hash}`;
}

export function FileViewerProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<FileViewerState | null>(null);
  // Whether THIS overlay session added a history entry (drives close: back vs
  // replaceState-strip, row c).
  const sessionPushed = useRef(false);

  const open = useCallback((path: string, opts?: OpenOptions) => {
    const sequence = opts?.sequence ?? [];
    const index = opts?.index ?? (sequence.length ? Math.max(0, sequence.indexOf(path)) : 0);
    setState((prev) => {
      if (prev) {
        // Replace-in-place (concurrent open), row b′: no extra history
        // entry, just retarget.
        window.history.replaceState(window.history.state, "", urlWithPath(path));
      } else {
        // Fresh open. If the URL already carries this path (mount auto-open /
        // direct link, row d), the history entry exists already; don't
        // push. Otherwise push one entry so Back closes (row a/c).
        if (readPathParam() === path) {
          sessionPushed.current = false;
        } else {
          window.history.pushState(window.history.state, "", urlWithPath(path));
          sessionPushed.current = true;
        }
      }
      return { path, sequence, index };
    });
  }, []);

  const navigate = useCallback((nextIndex: number) => {
    // In-sequence ←/→, row b: replaceState only, never a new entry.
    setState((prev) => {
      if (!prev || nextIndex < 0 || nextIndex >= prev.sequence.length) return prev;
      const path = prev.sequence[nextIndex]!;
      window.history.replaceState(window.history.state, "", urlWithPath(path));
      return { ...prev, path, index: nextIndex };
    });
  }, []);

  const close = useCallback(() => {
    if (sessionPushed.current) {
      sessionPushed.current = false;
      setState(null);
      // Remove our pushed entry; the popstate handler is a no-op (state already
      // cleared) but keeps the URL honest if anything raced.
      window.history.back();
    } else {
      // Landed via refresh/direct link (no push this session), so strip the param
      // in place so the URL stops deep-linking a closed overlay (row c).
      window.history.replaceState(window.history.state, "", urlWithPath(null));
      setState(null);
    }
  }, []);

  // row d: auto-open on mount if the URL already carries ?path=. Runs once.
  useEffect(() => {
    const initial = readPathParam();
    if (initial) {
      sessionPushed.current = false; // the entry already exists
      setState({ path: initial, sequence: [], index: 0 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browser Back/Forward → sync overlay to the URL. Back after a push removes
  // ?path= → close; Forward into a deep link → open.
  useEffect(() => {
    const onPop = () => {
      const param = readPathParam();
      sessionPushed.current = false; // a popstate target's entry already exists
      setState((prev) => {
        if (!param) return null; // Back closed it
        if (prev && prev.path === param) return prev;
        return { path: param, sequence: [], index: 0 };
      });
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const api = useMemo<FileViewerApi>(() => ({ open }), [open]);

  return (
    <FileViewerContext.Provider value={api}>
      {children}
      {state && (
        <Suspense fallback={null}>
          <FileViewerOverlay state={state} onClose={close} onNavigate={navigate} />
        </Suspense>
      )}
    </FileViewerContext.Provider>
  );
}

/** Open a file in the shared viewer overlay. Throws if no provider is mounted
 * (a wiring bug; the provider lives in the root layout). */
export function useFileViewer(): FileViewerApi {
  const ctx = useContext(FileViewerContext);
  if (!ctx) {
    throw new Error(
      "useFileViewer must be used within a FileViewerProvider (mount it in the root layout)",
    );
  }
  return ctx;
}
