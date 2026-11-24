"use client";

import { Folder } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { type FileIconMap, fileIconUrl, resolveFileIcon } from "@/lib/file-icons/resolve";
import { iconForFile } from "./file-icons";

/**
 * File and folder icons from the bundled icon pack (Material Icon Theme, MIT).
 *
 * The browser downloads the compact name → icon map once per page load and
 * every icon once per pack version, so a long listing costs one request per
 * distinct icon. Until the map arrives, or when the pack is unavailable, the
 * matching lucide glyph stands in at the same size.
 */

let map: FileIconMap | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(): void {
  if (loading) return;
  loading = fetch("/api/file/icons/map")
    .then((response) => (response.ok ? (response.json() as Promise<FileIconMap>) : null))
    .then((loaded) => {
      if (!loaded) return;
      map = loaded;
      for (const listener of listeners) listener();
    })
    .catch(() => {
      // The lucide fallback stays; a later mount may try again.
      loading = null;
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFileIconMap(): FileIconMap | null {
  const current = useSyncExternalStore(
    subscribe,
    () => map,
    () => null,
  );
  useEffect(() => {
    if (!map) load();
  }, []);
  return current;
}

export function FileTypeIcon({
  name,
  kind,
  className = "size-4",
}: {
  name: string;
  kind: "file" | "dir";
  /** Size classes; the icon is square. */
  className?: string;
}) {
  const icons = useFileIconMap();
  if (!icons) {
    const Fallback = kind === "dir" ? Folder : iconForFile(name);
    return <Fallback aria-hidden className={`shrink-0 text-muted-foreground ${className}`} />;
  }
  const dark = resolveFileIcon(icons, name, kind, "dark");
  const light = resolveFileIcon(icons, name, kind, "light");
  const image = (id: string, extra: string) => (
    // biome-ignore lint/performance/noImgElement: tiny static SVGs with permanent cache headers.
    <img
      key={id}
      src={fileIconUrl(id, icons.v)}
      alt=""
      aria-hidden
      draggable={false}
      decoding="async"
      data-file-icon={id}
      className={`shrink-0 select-none ${className} ${extra}`}
    />
  );
  // A few icons are too pale for a light background; the pack ships darker twins.
  if (dark === light) return image(dark, "");
  return (
    <>
      {image(light, "dark:hidden")}
      {image(dark, "hidden dark:inline-block")}
    </>
  );
}
